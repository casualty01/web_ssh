package model

import "time"

// AdminAuth holds the web UI login credentials. The password is never
// stored in plaintext: PasswordHash is sha256(Salt + ":" + password).
type AdminAuth struct {
	Username     string    `json:"username"`
	PasswordHash string    `json:"passwordHash"`
	Salt         string    `json:"salt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// Group is a folder used to organize saved SSH sessions in the tree view.
type Group struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	ParentID  string    `json:"parentId,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// AuthType enumerates supported SSH authentication modes.
type AuthType string

const (
	AuthPassword   AuthType = "password"
	AuthPrivateKey AuthType = "privateKey"
)

// Session is a saved SSH connection profile (like an Xshell "session").
type Session struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	GroupID    string    `json:"groupId,omitempty"`
	Host       string    `json:"host"`
	Port       int       `json:"port"`
	Username   string    `json:"username"`
	AuthType   AuthType  `json:"authType"`
	Password   string    `json:"password,omitempty"`   // stored as-is in the JSON store; see README for encryption note
	PrivateKey string    `json:"privateKey,omitempty"`  // PEM contents
	Passphrase string    `json:"passphrase,omitempty"`  // private key passphrase
	Term       string    `json:"term,omitempty"`        // e.g. xterm-256color
	// KeepAliveInterval is the SSH keepalive period in seconds. nil (field
	// absent, e.g. sessions saved before this option existed) means "use
	// DefaultKeepAliveInterval"; 0 or a negative value turns keepalive off.
	KeepAliveInterval *int      `json:"keepAliveInterval,omitempty"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

// DefaultKeepAliveInterval is the keepalive period (seconds) used when a
// session doesn't specify one.
const DefaultKeepAliveInterval = 30

// MaxKeepAliveInterval caps the configurable keepalive period (seconds).
const MaxKeepAliveInterval = 3600

// KeepAliveSeconds resolves the effective keepalive period in seconds;
// 0 means keepalive is disabled.
func (s Session) KeepAliveSeconds() int {
	if s.KeepAliveInterval == nil {
		return DefaultKeepAliveInterval
	}
	n := *s.KeepAliveInterval
	if n <= 0 {
		return 0
	}
	if n > MaxKeepAliveInterval {
		return MaxKeepAliveInterval
	}
	return n
}

// SessionPublic strips secrets before sending a session list to the browser.
type SessionPublic struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	GroupID   string    `json:"groupId,omitempty"`
	Host      string    `json:"host"`
	Port      int       `json:"port"`
	Username  string    `json:"username"`
	AuthType  AuthType  `json:"authType"`
	HasSecret bool      `json:"hasSecret"`
	// KeepAliveInterval is the effective keepalive period in seconds
	// (0 = disabled), with the default already applied.
	KeepAliveInterval int       `json:"keepAliveInterval"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

func (s Session) Public() SessionPublic {
	return SessionPublic{
		ID: s.ID, Name: s.Name, GroupID: s.GroupID, Host: s.Host, Port: s.Port,
		Username: s.Username, AuthType: s.AuthType,
		HasSecret:         s.Password != "" || s.PrivateKey != "",
		KeepAliveInterval: s.KeepAliveSeconds(),
		CreatedAt:         s.CreatedAt, UpdatedAt: s.UpdatedAt,
	}
}

// TunnelType enumerates the three SSH port-forwarding modes Xshell exposes
// in its Tunnel manager.
type TunnelType string

const (
	TunnelLocal   TunnelType = "local"   // -L : listen locally, forward to remote target
	TunnelRemote  TunnelType = "remote"  // -R : listen on remote server, forward to local target
	TunnelDynamic TunnelType = "dynamic" // -D : local SOCKS5 proxy
)

// Tunnel is a saved port-forwarding rule attached to a Session.
type Tunnel struct {
	ID         string     `json:"id"`
	SessionID  string     `json:"sessionId"`
	Name       string     `json:"name"`
	Type       TunnelType `json:"type"`
	ListenHost string     `json:"listenHost"`
	ListenPort int        `json:"listenPort"`
	TargetHost string     `json:"targetHost,omitempty"` // unused for dynamic
	TargetPort int        `json:"targetPort,omitempty"` // unused for dynamic
	AutoStart  bool       `json:"autoStart"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

// TunnelStatus is the live (non-persisted) running state of a tunnel.
type TunnelStatus struct {
	TunnelID string `json:"tunnelId"`
	Running  bool   `json:"running"`
	Error    string `json:"error,omitempty"`
}
