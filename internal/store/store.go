// Package store implements a small, dependency-free persistence layer.
// Data is kept in memory and flushed to a single JSON file on every write.
// This is intentionally simple (no external DB) but is safe for concurrent
// use and durable across container restarts as long as the data directory
// is mounted on a volume.
package store

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"webssh/internal/model"
)

var ErrNotFound = errors.New("not found")

type data struct {
	Groups   map[string]model.Group   `json:"groups"`
	Sessions map[string]model.Session `json:"sessions"`
	Tunnels  map[string]model.Tunnel  `json:"tunnels"`
	Admin    model.AdminAuth          `json:"admin"`
}

type Store struct {
	mu   sync.RWMutex
	path string
	d    data
}

func New(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	s := &Store{
		path: filepath.Join(dataDir, "store.json"),
		d: data{
			Groups:   map[string]model.Group{},
			Sessions: map[string]model.Session{},
			Tunnels:  map[string]model.Tunnel{},
		},
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return nil
	}
	return json.Unmarshal(b, &s.d)
}

// mustPersist saves the current state to disk. Caller must hold s.mu (write lock).
func (s *Store) persist() error {
	tmp := s.path + ".tmp"
	b, err := json.MarshalIndent(s.d, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

// ---------- Admin credentials ----------

// GetAdmin returns the persisted admin credentials. ok is false if no
// password has ever been set (i.e. the caller should fall back to the
// env-configured defaults).
func (s *Store) GetAdmin() (model.AdminAuth, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.d.Admin.PasswordHash == "" {
		return model.AdminAuth{}, false
	}
	return s.d.Admin, true
}

func (s *Store) SetAdmin(a model.AdminAuth) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a.UpdatedAt = time.Now().UTC()
	s.d.Admin = a
	return s.persist()
}

// ---------- Groups ----------

func (s *Store) ListGroups() []model.Group {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Group, 0, len(s.d.Groups))
	for _, g := range s.d.Groups {
		out = append(out, g)
	}
	return out
}

func (s *Store) CreateGroup(g model.Group) (model.Group, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g.ID = newID()
	now := time.Now().UTC()
	g.CreatedAt, g.UpdatedAt = now, now
	s.d.Groups[g.ID] = g
	return g, s.persist()
}

func (s *Store) UpdateGroup(id string, name string, parentID string) (model.Group, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.d.Groups[id]
	if !ok {
		return model.Group{}, ErrNotFound
	}
	g.Name = name
	g.ParentID = parentID
	g.UpdatedAt = time.Now().UTC()
	s.d.Groups[id] = g
	return g, s.persist()
}

func (s *Store) DeleteGroup(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.d.Groups[id]; !ok {
		return ErrNotFound
	}
	delete(s.d.Groups, id)
	// ungroup any sessions that pointed at this group
	for k, sess := range s.d.Sessions {
		if sess.GroupID == id {
			sess.GroupID = ""
			s.d.Sessions[k] = sess
		}
	}
	return s.persist()
}

// ---------- Sessions ----------

func (s *Store) ListSessions() []model.Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Session, 0, len(s.d.Sessions))
	for _, sess := range s.d.Sessions {
		out = append(out, sess)
	}
	return out
}

func (s *Store) GetSession(id string) (model.Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.d.Sessions[id]
	if !ok {
		return model.Session{}, ErrNotFound
	}
	return sess, nil
}

func (s *Store) CreateSession(sess model.Session) (model.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess.ID = newID()
	now := time.Now().UTC()
	sess.CreatedAt, sess.UpdatedAt = now, now
	if sess.Term == "" {
		sess.Term = "xterm-256color"
	}
	if sess.Port == 0 {
		sess.Port = 22
	}
	s.d.Sessions[sess.ID] = sess
	return sess, s.persist()
}

// UpdateSession replaces fields; if incoming secret fields are empty the
// existing stored secret is preserved (so the UI doesn't have to resend
// passwords/keys on every rename).
func (s *Store) UpdateSession(id string, in model.Session) (model.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.d.Sessions[id]
	if !ok {
		return model.Session{}, ErrNotFound
	}
	cur.Name = in.Name
	cur.GroupID = in.GroupID
	cur.Host = in.Host
	cur.Port = in.Port
	cur.Username = in.Username
	cur.AuthType = in.AuthType
	cur.Term = in.Term
	cur.KeepAliveInterval = in.KeepAliveInterval
	if in.Password != "" {
		cur.Password = in.Password
	}
	if in.PrivateKey != "" {
		cur.PrivateKey = in.PrivateKey
	}
	if in.Passphrase != "" {
		cur.Passphrase = in.Passphrase
	}
	cur.UpdatedAt = time.Now().UTC()
	s.d.Sessions[id] = cur
	return cur, s.persist()
}

func (s *Store) DeleteSession(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.d.Sessions[id]; !ok {
		return ErrNotFound
	}
	delete(s.d.Sessions, id)
	for k, t := range s.d.Tunnels {
		if t.SessionID == id {
			delete(s.d.Tunnels, k)
		}
	}
	return s.persist()
}

// ---------- Tunnels ----------

func (s *Store) ListTunnels() []model.Tunnel {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Tunnel, 0, len(s.d.Tunnels))
	for _, t := range s.d.Tunnels {
		out = append(out, t)
	}
	return out
}

func (s *Store) GetTunnel(id string) (model.Tunnel, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.d.Tunnels[id]
	if !ok {
		return model.Tunnel{}, ErrNotFound
	}
	return t, nil
}

func (s *Store) CreateTunnel(t model.Tunnel) (model.Tunnel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t.ID = newID()
	now := time.Now().UTC()
	t.CreatedAt, t.UpdatedAt = now, now
	if t.ListenHost == "" {
		t.ListenHost = "127.0.0.1"
	}
	s.d.Tunnels[t.ID] = t
	return t, s.persist()
}

func (s *Store) UpdateTunnel(id string, in model.Tunnel) (model.Tunnel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.d.Tunnels[id]
	if !ok {
		return model.Tunnel{}, ErrNotFound
	}
	in.ID = cur.ID
	in.CreatedAt = cur.CreatedAt
	in.UpdatedAt = time.Now().UTC()
	s.d.Tunnels[id] = in
	return in, s.persist()
}

func (s *Store) DeleteTunnel(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.d.Tunnels[id]; !ok {
		return ErrNotFound
	}
	delete(s.d.Tunnels, id)
	return s.persist()
}
