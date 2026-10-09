package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"webssh/internal/sshsvc"
	"webssh/internal/store"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Same-origin browser app; allow all so it also works behind reverse proxies.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// A clean disconnect (tab closed, navigated away) sends a WS close frame
// and ReadMessage returns almost immediately. A silent one (wifi died,
// laptop slept, cable pulled) sends nothing — without a deadline,
// ReadMessage would just block forever and we'd never notice the browser
// is gone. So every connection gets a read deadline that only pongWait
// heartbeats can keep pushing forward; miss enough of them and the
// connection is presumed dead and torn down like any other disconnect.
const (
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

// wsInMsg is sent by the browser terminal.
type wsInMsg struct {
	Type string `json:"type"` // "data" | "resize" | "close"
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// wsOutMsg is sent to the browser terminal.
type wsOutMsg struct {
	Type    string `json:"type"` // "data" | "error" | "closed"
	Data    string `json:"data,omitempty"`
	Message string `json:"message,omitempty"`
}

// wsConn wraps a websocket connection with a write-side mutex. A single
// connection here gets written to from several independent goroutines —
// the attached liveTerm's output pump, this file's own heartbeat ticker,
// and the request handler itself — and gorilla's Conn only tolerates one
// writer at a time, so every write funnels through here instead of
// touching the raw *websocket.Conn directly.
type wsConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *wsConn) writeJSON(msg wsOutMsg) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.TextMessage, b)
}

func (c *wsConn) ping() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.PingMessage, nil)
}

// handleWSSSH upgrades the connection and attaches it to the interactive
// SSH PTY for the given (session, terminal) pair — reusing the still-running
// shell if "term" already has one (a page refresh reconnecting), or starting
// a fresh one if it doesn't (a brand new tab).
func (s *Server) handleWSSSH(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	termID := r.URL.Query().Get("term")
	if id == "" || termID == "" {
		http.Error(w, "missing session id or terminal id", http.StatusBadRequest)
		return
	}
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))

	sess, err := s.store.GetSession(id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// Browsers answer WS ping frames with pong frames automatically at the
	// protocol level (no client-side JS needed); each pong pushes the
	// deadline back out. Silence for a full pongWait — heartbeat included
	// — means the connection is gone even if the OS never told us.
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	wc := &wsConn{conn: conn}
	pingDone := make(chan struct{})
	defer close(pingDone)
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if wc.ping() != nil {
					return
				}
			case <-pingDone:
				return
			}
		}
	}()

	lt, existed := s.terms.get(termID)
	if !existed {
		lt, err = s.terms.create(termID, sess, cols, rows)
		if err != nil {
			wc.writeJSON(wsOutMsg{Type: "error", Message: err.Error()})
			return
		}
	} else {
		// Reattaching to a shell that kept running in the background:
		// this is the whole point — cwd, the running command, and the
		// scrollback all survive the refresh. Just sync the PTY size,
		// since the browser window may have been resized meanwhile.
		_ = sshsvc.Resize(lt.session, cols, rows)
	}

	lt.attach(wc)
	defer lt.detach(wc)

	// WebSocket -> SSH stdin, plus resize/close control messages. This
	// loop returning — whether from a clean close, a missed heartbeat, or
	// a plain network drop — does NOT kill the shell; only an explicit
	// "close" message, or the remote shell exiting on its own, does that.
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var in wsInMsg
		if err := json.Unmarshal(raw, &in); err != nil {
			continue
		}
		switch in.Type {
		case "data":
			if _, err := lt.stdin.Write([]byte(in.Data)); err != nil {
				return
			}
		case "resize":
			_ = sshsvc.Resize(lt.session, in.Cols, in.Rows)
		case "close":
			s.terms.terminate(termID)
			return
		}
	}
}
