package sshsvc

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"golang.org/x/crypto/ssh"
)

// serveSOCKS5 implements just enough of RFC 1928 to support the CONNECT
// command with no authentication, which is all a browser/CLI client needs
// to use this as a SOCKS proxy (e.g. `curl -x socks5h://127.0.0.1:1080`).
func serveSOCKS5(ln net.Listener, client *ssh.Client) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go handleSOCKSConn(conn, client)
	}
}

func handleSOCKSConn(conn net.Conn, client *ssh.Client) {
	defer conn.Close()

	// --- greeting ---
	buf := make([]byte, 262)
	if _, err := io.ReadFull(conn, buf[:2]); err != nil {
		return
	}
	if buf[0] != 0x05 { // SOCKS version 5 only
		return
	}
	nmethods := int(buf[1])
	if _, err := io.ReadFull(conn, buf[:nmethods]); err != nil {
		return
	}
	// no-auth
	if _, err := conn.Write([]byte{0x05, 0x00}); err != nil {
		return
	}

	// --- request ---
	if _, err := io.ReadFull(conn, buf[:4]); err != nil {
		return
	}
	ver, cmd, _, atyp := buf[0], buf[1], buf[2], buf[3]
	if ver != 0x05 || cmd != 0x01 { // only CONNECT supported
		writeSOCKSReply(conn, 0x07) // command not supported
		return
	}

	var host string
	switch atyp {
	case 0x01: // IPv4
		if _, err := io.ReadFull(conn, buf[:4]); err != nil {
			return
		}
		host = net.IP(buf[:4]).String()
	case 0x03: // domain name
		if _, err := io.ReadFull(conn, buf[:1]); err != nil {
			return
		}
		l := int(buf[0])
		if _, err := io.ReadFull(conn, buf[:l]); err != nil {
			return
		}
		host = string(buf[:l])
	case 0x04: // IPv6
		if _, err := io.ReadFull(conn, buf[:16]); err != nil {
			return
		}
		host = net.IP(buf[:16]).String()
	default:
		writeSOCKSReply(conn, 0x08) // address type not supported
		return
	}
	if _, err := io.ReadFull(conn, buf[:2]); err != nil {
		return
	}
	port := binary.BigEndian.Uint16(buf[:2])
	target := fmt.Sprintf("%s:%d", host, port)

	remote, err := client.Dial("tcp", target)
	if err != nil {
		writeSOCKSReply(conn, 0x05) // connection refused
		return
	}
	defer remote.Close()

	if err := writeSOCKSReply(conn, 0x00); err != nil {
		return
	}
	pipe(conn, remote)
}

func writeSOCKSReply(conn net.Conn, rep byte) error {
	// BND.ADDR/BND.PORT are not meaningful for our use case; send 0.0.0.0:0.
	reply := []byte{0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0}
	_, err := conn.Write(reply)
	if err != nil {
		return errors.New("write socks reply: " + err.Error())
	}
	return nil
}
