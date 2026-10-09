package httpapi

import (
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"webssh/internal/model"
	"webssh/internal/sshsvc"
)

// How long a live PTY is kept running in the background with nobody
// attached before we give up and tear it down. A page refresh reattaches
// almost instantly; this just bounds how long an abandoned tab (browser
// closed, laptop went to sleep, ...) leaks a real SSH connection for.
const termIdleGrace = 30 * time.Minute

// How much recent output we buffer so a reconnecting browser can be
// caught up. This is a raw-byte replay, not a real screen redraw the way
// `tmux attach` reconstructs the current screen — so a full-screen app
// (vim, htop) may look slightly off if the buffer wrapped during a very
// long detach, but for "I refreshed the page" it reproduces the screen.
const termScrollbackCap = 64 * 1024

// liveTerm is one real, running SSH PTY shell that outlives any single
// WebSocket connection. Closing/refreshing the tab drops the socket but
// not this — the remote shell (cwd, running command, output) just sits
// here until the same termID attaches again.
type liveTerm struct {
	id      string
	mgr     *termManager
	client  *ssh.Client
	session *ssh.Session
	stdin   interface{ Write([]byte) (int, error) }

	mu         sync.Mutex
	conn       *wsConn // currently attached browser socket, or nil
	scrollback []byte
	dead       bool
	idleTimer  *time.Timer
}

// termManager tracks live PTY shells across WebSocket reconnects, keyed
// by a per-tab id the browser mints once (persisted in its own
// localStorage) and reuses on every reconnect for that tab.
type termManager struct {
	mu    sync.Mutex
	terms map[string]*liveTerm
}

func newTermManager() *termManager {
	return &termManager{terms: map[string]*liveTerm{}}
}

// get returns the live terminal for termID, if one is running.
func (m *termManager) get(termID string) (*liveTerm, bool) {
	m.mu.Lock()
	lt, ok := m.terms[termID]
	m.mu.Unlock()
	return lt, ok
}

// create dials a fresh SSH connection and starts a PTY shell, registering
// it under termID so a future reconnect with the same id can attach to it
// instead of starting a new shell.
func (m *termManager) create(termID string, sess model.Session, cols, rows int) (*liveTerm, error) {
	client, err := sshsvc.Dial(sess)
	if err != nil {
		return nil, err
	}
	session, stdin, stdout, err := sshsvc.StartShell(client, sess.Term, cols, rows)
	if err != nil {
		client.Close()
		return nil, err
	}

	lt := &liveTerm{id: termID, mgr: m, client: client, session: session, stdin: stdin}
	m.mu.Lock()
	m.terms[termID] = lt
	m.mu.Unlock()

	go lt.pump(stdout)
	return lt, nil
}

// terminate kills a live terminal outright (used when the user explicitly
// closes the tab, so we don't idle it out for the full grace period).
func (m *termManager) terminate(termID string) {
	m.mu.Lock()
	lt, ok := m.terms[termID]
	if ok {
		delete(m.terms, termID)
	}
	m.mu.Unlock()
	if ok {
		lt.kill()
	}
}

func (m *termManager) remove(termID string) {
	m.mu.Lock()
	delete(m.terms, termID)
	m.mu.Unlock()
}

// pump continuously drains the SSH shell's stdout, feeding it into the
// scrollback buffer and, if a browser is currently attached, straight out
// over its WebSocket. It runs for the lifetime of the shell, independent
// of any one WebSocket connection.
func (t *liveTerm) pump(stdout interface{ Read([]byte) (int, error) }) {
	buf := make([]byte, 8192)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			t.broadcast(buf[:n])
		}
		if err != nil {
			t.finish()
			return
		}
	}
}

func (t *liveTerm) broadcast(p []byte) {
	t.mu.Lock()
	t.scrollback = append(t.scrollback, p...)
	if over := len(t.scrollback) - termScrollbackCap; over > 0 {
		t.scrollback = t.scrollback[over:]
	}
	conn := t.conn
	t.mu.Unlock()

	if conn == nil {
		return
	}
	if conn.writeJSON(wsOutMsg{Type: "data", Data: string(p)}) != nil {
		// The socket's bad; just detach. The shell stays alive and a
		// fresh reconnect will replay the scrollback to catch up.
		t.mu.Lock()
		if t.conn == conn {
			t.conn = nil
		}
		t.mu.Unlock()
	}
}

// finish runs when the remote shell itself exits (e.g. the user typed
// `exit`) — there's nothing left to reattach to, so clean up for real.
func (t *liveTerm) finish() {
	t.mu.Lock()
	if t.dead {
		t.mu.Unlock()
		return
	}
	t.dead = true
	conn := t.conn
	t.conn = nil
	if t.idleTimer != nil {
		t.idleTimer.Stop()
	}
	t.mu.Unlock()

	if conn != nil {
		conn.writeJSON(wsOutMsg{Type: "closed"})
		conn.conn.Close() // force the attached handleWSSSH loop to unblock and return
	}
	t.session.Close()
	t.client.Close()
	t.mgr.remove(t.id)
}

// kill tears down a still-running shell on request (explicit tab close).
func (t *liveTerm) kill() {
	t.mu.Lock()
	if t.dead {
		t.mu.Unlock()
		return
	}
	t.dead = true
	conn := t.conn
	t.conn = nil
	if t.idleTimer != nil {
		t.idleTimer.Stop()
	}
	t.mu.Unlock()

	if conn != nil {
		conn.writeJSON(wsOutMsg{Type: "closed"})
		conn.conn.Close()
	}
	t.session.Close()
	t.client.Close()
}

// attach hooks a freshly (re)connected WebSocket up to this shell and
// replays whatever scrollback has piled up since the last time anyone
// was watching, so the browser catches back up to where the shell is now.
func (t *liveTerm) attach(conn *wsConn) {
	t.mu.Lock()
	if t.idleTimer != nil {
		t.idleTimer.Stop()
		t.idleTimer = nil
	}
	replay := append([]byte(nil), t.scrollback...)
	t.conn = conn
	t.mu.Unlock()

	if len(replay) > 0 {
		conn.writeJSON(wsOutMsg{Type: "data", Data: string(replay)})
	}
}

// detach unhooks a WebSocket connection that just closed (page refresh,
// network blip, tab backgrounded, ...) without killing the remote shell.
// If nobody reattaches within termIdleGrace, the shell is torn down.
func (t *liveTerm) detach(conn *wsConn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.conn != conn {
		return // already replaced by a newer connection for this termID
	}
	t.conn = nil
	if t.dead {
		return
	}
	id, mgr := t.id, t.mgr
	t.idleTimer = time.AfterFunc(termIdleGrace, func() {
		mgr.terminate(id)
	})
}
