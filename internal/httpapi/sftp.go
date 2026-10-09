package httpapi

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	stdpath "path"
	"strings"
	"webssh/internal/model"
	"webssh/internal/sshsvc"
	"webssh/internal/store"
)

// handleSFTP routes /api/sftp/{sessionId}/{action}. Each request opens a
// short-lived SFTP connection using the session's saved credentials; there
// is no persistent per-session SFTP connection to keep the server simple
// and to avoid leaking connections if a browser tab is left open.
func (s *Server) handleSFTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/sftp/")
	sessionID, action, ok := strings.Cut(rest, "/")
	if !ok || sessionID == "" || action == "" {
		writeErr(w, http.StatusBadRequest, "expected /api/sftp/{sessionId}/{action}")
		return
	}

	sess, err := s.store.GetSession(sessionID)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "session not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	// "download" streams the response body directly, so it needs to set its
	// own headers/status rather than going through the JSON helpers below.
	if action == "download" {
		if r.Method != http.MethodGet {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.sftpDownload(w, r, sess)
		return
	}

	client, sc, err := sshsvc.DialSFTP(sess)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	defer sc.Close()
	defer client.Close()

	switch action {
	case "list":
		if r.Method != http.MethodGet {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		dir := r.URL.Query().Get("path")
		entries, err := sshsvc.SFTPList(sc, dir)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"path": dir, "entries": entries})

	case "mkdir":
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var in struct {
			Path string `json:"path"`
		}
		if err := decodeJSON(r, &in); err != nil || in.Path == "" {
			writeErr(w, http.StatusBadRequest, "path is required")
			return
		}
		if err := sshsvc.SFTPMkdir(sc, in.Path); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})

	case "rename":
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var in struct {
			OldPath string `json:"oldPath"`
			NewPath string `json:"newPath"`
		}
		if err := decodeJSON(r, &in); err != nil || in.OldPath == "" || in.NewPath == "" {
			writeErr(w, http.StatusBadRequest, "oldPath and newPath are required")
			return
		}
		if err := sshsvc.SFTPRename(sc, in.OldPath, in.NewPath); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})

	case "remove":
		if r.Method != http.MethodDelete {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		p := r.URL.Query().Get("path")
		if p == "" || p == "." || p == "/" {
			writeErr(w, http.StatusBadRequest, "refusing to remove root/empty path")
			return
		}
		if err := sshsvc.SFTPRemoveAll(sc, p); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})

	case "upload":
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		dir := r.URL.Query().Get("path")
		if dir == "" {
			dir = "."
		}
		// Stream the multipart body straight through to the remote file
		// instead of ParseMultipartForm (which first buffers the whole
		// upload to memory/temp disk). Streaming means the browser's
		// upload progress tracks the real end-to-end transfer: bytes are
		// only accepted as fast as the SFTP side can write them.
		mr, err := r.MultipartReader()
		if err != nil {
			writeErr(w, http.StatusBadRequest, "expected multipart/form-data: "+err.Error())
			return
		}
		uploaded := []string{}
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				writeErr(w, http.StatusBadRequest, "invalid multipart body: "+err.Error())
				return
			}
			name := uploadFileName(part.FileName())
			if part.FormName() != "file" || name == "" {
				part.Close()
				continue
			}
			err = sshsvc.SFTPUpload(sc, dir, name, part)
			part.Close()
			if err != nil {
				writeErr(w, http.StatusBadGateway, fmt.Sprintf("upload %s: %v", name, err))
				return
			}
			uploaded = append(uploaded, name)
		}
		if len(uploaded) == 0 {
			writeErr(w, http.StatusBadRequest, `no file provided (field name must be "file")`)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "uploaded": uploaded})

	default:
		writeErr(w, http.StatusNotFound, "unknown action")
	}
}

// sftpDownload streams a single remote file back to the browser with a
// Content-Disposition header so it saves with its original filename.
func (s *Server) sftpDownload(w http.ResponseWriter, r *http.Request, sess model.Session) {
	p := r.URL.Query().Get("path")
	if p == "" {
		writeErr(w, http.StatusBadRequest, "path is required")
		return
	}

	client, sc, err := sshsvc.DialSFTP(sess)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	defer sc.Close()
	defer client.Close()

	f, err := sshsvc.SFTPDownload(sc, p)
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	defer f.Close()

	if fi, err := f.Stat(); err == nil && !fi.IsDir() {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", fi.Size()))
	}
	name := stdpath.Base(p)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, strings.ReplaceAll(name, `"`, `'`)))
	w.WriteHeader(http.StatusOK)
	buf := make([]byte, 32*1024)
	for {
		n, rerr := f.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
		}
		if rerr != nil {
			return
		}
	}
}

// uploadFileName reduces a client-supplied multipart filename to a bare
// file name (no directory components, either separator style).
func uploadFileName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = stdpath.Base(name)
	if name == "." || name == "/" || name == ".." {
		return ""
	}
	return name
}
