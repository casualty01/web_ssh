package sshsvc

import (
	"time"

	"golang.org/x/crypto/ssh"
)

// keepAliveRequest is the same global request OpenSSH's own client sends
// for ServerAliveInterval. A server that doesn't recognise it still answers
// (with a "request failure"), which is all we need to know the link is up.
const keepAliveRequest = "keepalive@openssh.com"

// keepAliveMaxFail is how many consecutive unanswered probes we tolerate
// before declaring the connection dead (OpenSSH's ServerAliveCountMax).
const keepAliveMaxFail = 3

// startKeepAlive sends a keepalive probe over client every interval until
// the connection closes. It does two jobs:
//
//   - keeps idle connections from being dropped by NAT gateways, firewalls
//     or load balancers that expire quiet TCP flows, and
//   - notices a connection that died silently (network gone, peer
//     rebooted): after keepAliveMaxFail unanswered probes it closes client,
//     which makes every reader on it (terminal pump, SFTP, tunnels) return
//     promptly instead of hanging until the OS gives up on the socket.
//
// interval must be > 0. The goroutine exits on its own when the client is
// closed, so callers don't need to stop it.
func startKeepAlive(client *ssh.Client, interval time.Duration) {
	closed := make(chan struct{})
	go func() {
		_ = client.Wait() // returns once the connection is gone
		close(closed)
	}()

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		fails := 0
		for {
			select {
			case <-closed:
				return
			case <-ticker.C:
			}

			res := make(chan error, 1)
			go func() {
				_, _, err := client.SendRequest(keepAliveRequest, true, nil)
				res <- err
			}()

			select {
			case err := <-res:
				if err != nil {
					fails++
				} else {
					fails = 0
				}
			case <-time.After(interval):
				// No answer within one interval counts as a miss.
				fails++
			case <-closed:
				return
			}

			if fails >= keepAliveMaxFail {
				_ = client.Close()
				return
			}
		}
	}()
}
