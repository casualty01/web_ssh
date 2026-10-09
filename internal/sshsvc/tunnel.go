package sshsvc

import (
	"fmt"
	"io"
	"net"
	"sync"

	"golang.org/x/crypto/ssh"

	"webssh/internal/model"
)

type running struct {
	client   *ssh.Client
	listener net.Listener
	stop     chan struct{}
	lastErr  error
}

// TunnelManager tracks currently-running tunnels in memory (nothing here
// is persisted; the store package owns the saved tunnel *configs*).
type TunnelManager struct {
	mu     sync.Mutex
	active map[string]*running // tunnelID -> running
}

func NewTunnelManager() *TunnelManager {
	return &TunnelManager{active: map[string]*running{}}
}

func (m *TunnelManager) IsRunning(tunnelID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.active[tunnelID]
	return ok
}

func (m *TunnelManager) Status() map[string]bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]bool{}
	for id := range m.active {
		out[id] = true
	}
	return out
}

// Start dials a fresh SSH connection using the owning session's credentials
// and begins forwarding according to the tunnel's Type.
func (m *TunnelManager) Start(t model.Tunnel, sess model.Session) error {
	m.mu.Lock()
	if _, ok := m.active[t.ID]; ok {
		m.mu.Unlock()
		return fmt.Errorf("tunnel already running")
	}
	m.mu.Unlock()

	client, err := Dial(sess)
	if err != nil {
		return err
	}

	switch t.Type {
	case model.TunnelLocal:
		return m.startLocal(t, client)
	case model.TunnelRemote:
		return m.startRemote(t, client)
	case model.TunnelDynamic:
		return m.startDynamic(t, client)
	default:
		client.Close()
		return fmt.Errorf("unknown tunnel type %q", t.Type)
	}
}

func (m *TunnelManager) Stop(tunnelID string) error {
	m.mu.Lock()
	r, ok := m.active[tunnelID]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("tunnel not running")
	}
	delete(m.active, tunnelID)
	m.mu.Unlock()

	close(r.stop)
	if r.listener != nil {
		r.listener.Close()
	}
	if r.client != nil {
		r.client.Close()
	}
	return nil
}

func (m *TunnelManager) StopAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.active))
	for id := range m.active {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_ = m.Stop(id)
	}
}

// ---- local forward: listen on ListenHost:ListenPort locally, pipe each
// accepted connection through the SSH client to TargetHost:TargetPort. ----
func (m *TunnelManager) startLocal(t model.Tunnel, client *ssh.Client) error {
	addr := fmt.Sprintf("%s:%d", t.ListenHost, t.ListenPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		client.Close()
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	r := &running{client: client, listener: ln, stop: make(chan struct{})}
	m.mu.Lock()
	m.active[t.ID] = r
	m.mu.Unlock()

	go func() {
		target := fmt.Sprintf("%s:%d", t.TargetHost, t.TargetPort)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return // listener closed -> tunnel stopped
			}
			go func(c net.Conn) {
				defer c.Close()
				remote, err := client.Dial("tcp", target)
				if err != nil {
					return
				}
				defer remote.Close()
				pipe(c, remote)
			}(conn)
		}
	}()
	return nil
}

// ---- remote forward: ask the remote SSH server to listen on our behalf
// and forward incoming connections back down the tunnel to a local target. ----
func (m *TunnelManager) startRemote(t model.Tunnel, client *ssh.Client) error {
	remoteAddr := fmt.Sprintf("%s:%d", t.ListenHost, t.ListenPort)
	ln, err := client.Listen("tcp", remoteAddr)
	if err != nil {
		client.Close()
		return fmt.Errorf("remote listen %s: %w", remoteAddr, err)
	}
	r := &running{client: client, listener: ln, stop: make(chan struct{})}
	m.mu.Lock()
	m.active[t.ID] = r
	m.mu.Unlock()

	go func() {
		target := fmt.Sprintf("%s:%d", t.TargetHost, t.TargetPort)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				local, err := dialTimeout("tcp", target)
				if err != nil {
					return
				}
				defer local.Close()
				pipe(c, local)
			}(conn)
		}
	}()
	return nil
}

// ---- dynamic forward: local SOCKS5 proxy; each SOCKS CONNECT is dialed
// out through the SSH connection (implemented in socks.go). ----
func (m *TunnelManager) startDynamic(t model.Tunnel, client *ssh.Client) error {
	addr := fmt.Sprintf("%s:%d", t.ListenHost, t.ListenPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		client.Close()
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	r := &running{client: client, listener: ln, stop: make(chan struct{})}
	m.mu.Lock()
	m.active[t.ID] = r
	m.mu.Unlock()

	go serveSOCKS5(ln, client)
	return nil
}

func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(a, b); done <- struct{}{} }()
	go func() { io.Copy(b, a); done <- struct{}{} }()
	<-done
}
