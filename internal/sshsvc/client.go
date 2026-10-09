// Package sshsvc wraps golang.org/x/crypto/ssh to provide interactive
// shells (for the web terminal) and port-forwarding tunnels (local,
// remote and dynamic/SOCKS5), similar to Xshell's Session + Tunnel manager.
package sshsvc

import (
	"fmt"
	"net"
	"time"
	"golang.org/x/crypto/ssh"
	"webssh/internal/model"
)

// Dial opens a new SSH connection for the given saved session profile.
func Dial(sess model.Session) (*ssh.Client, error) {
	auth, err := authMethod(sess)
	if err != nil {
		return nil, err
	}
	cfg := &ssh.ClientConfig{
		User:            sess.Username,
		Auth:            []ssh.AuthMethod{auth},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // NOTE: for production, verify known_hosts instead.
		Timeout:         10 * time.Second,
	}
	addr := fmt.Sprintf("%s:%d", sess.Host, sess.Port)
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return nil, fmt.Errorf("ssh dial %s: %w", addr, err)
	}
	// Applies to every consumer of Dial (terminal, SFTP, tunnels). The
	// probe goroutine ends by itself when the client is closed.
	if n := sess.KeepAliveSeconds(); n > 0 {
		startKeepAlive(client, time.Duration(n)*time.Second)
	}
	return client, nil
}

func authMethod(sess model.Session) (ssh.AuthMethod, error) {
	switch sess.AuthType {
	case model.AuthPrivateKey:
		var signer ssh.Signer
		var err error
		if sess.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(sess.PrivateKey), []byte(sess.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(sess.PrivateKey))
		}
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return ssh.PublicKeys(signer), nil
	default: // password
		return ssh.Password(sess.Password), nil
	}
}

// Shell holds a live interactive PTY session bridged over one ssh.Client.
type Shell struct {
	Client  *ssh.Client
	Session *ssh.Session
	Stdin   interface{ Write([]byte) (int, error) }
	Stdout  interface{ Read([]byte) (int, error) }
}

// StartShell opens a new SSH session on client and requests a PTY + shell.
func StartShell(client *ssh.Client, term string, cols, rows int) (*ssh.Session, interface{ Write([]byte) (int, error) }, interface{ Read([]byte) (int, error) }, error) {
	session, err := client.NewSession()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("new ssh session: %w", err)
	}
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if term == "" {
		term = "xterm-256color"
	}
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	if err := session.RequestPty(term, rows, cols, modes); err != nil {
		session.Close()
		return nil, nil, nil, fmt.Errorf("request pty: %w", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		session.Close()
		return nil, nil, nil, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		session.Close()
		return nil, nil, nil, err
	}
	// merge stderr into stdout stream isn't directly available via pipes API;
	// most interactive shells write prompts/output to stdout anyway.
	if err := session.Shell(); err != nil {
		session.Close()
		return nil, nil, nil, fmt.Errorf("start shell: %w", err)
	}
	return session, stdin, stdout, nil
}

// Resize sends a window-change request for an already-running PTY session.
func Resize(session *ssh.Session, cols, rows int) error {
	if cols <= 0 || rows <= 0 {
		return nil
	}
	return session.WindowChange(rows, cols)
}

// dialTimeout is a small helper used by the tunnel manager to connect to
// forward targets with a bounded timeout.
func dialTimeout(network, addr string) (net.Conn, error) {
	return net.DialTimeout(network, addr, 10*time.Second)
}
