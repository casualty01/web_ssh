package httpapi

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	stdpath "path"
	"strings"

	"github.com/pkg/sftp"

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

	// "archive" streams a zip of several files/folders, same reasoning.
	if action == "archive" {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.sftpArchive(w, r, sess)
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
		// Turn "." / relative input into the real absolute path so the
		// UI can offer clickable path segments.
		if abs, err := sshsvc.SFTPRealPath(sc, dir); err == nil {
			dir = abs
		}
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

	case "batch":
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.sftpBatch(w, r, sc)

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
		madeDirs := map[string]bool{}
		pendingRel := ""
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				writeErr(w, http.StatusBadRequest, "invalid multipart body: "+err.Error())
				return
			}
			// A "relpath" field precedes each file and carries its relative
			// path ("folder/sub/a.txt") when a whole folder is uploaded.
			// Browsers may rewrite "/" inside a multipart filename, so the
			// field is the reliable source; the filename is only a fallback
			// for older clients. Parent folders are created on demand under
			// the target directory.
			if part.FormName() == "relpath" {
				b, _ := io.ReadAll(io.LimitReader(part, 4096))
				part.Close()
				pendingRel = uploadRelPath(string(b))
				continue
			}
			rel := ""
			if part.FormName() == "file" {
				rel = pendingRel
				pendingRel = ""
				if rel == "" {
					rel = uploadRelPath(rawUploadName(part))
				}
			}
			if rel == "" {
				part.Close()
				continue
			}
			subdir, name := stdpath.Split(rel)
			target := dir
			if subdir != "" {
				target = stdpath.Join(dir, subdir)
				if !madeDirs[target] {
					if err := sshsvc.SFTPMkdir(sc, target); err != nil {
						part.Close()
						writeErr(w, http.StatusBadGateway, fmt.Sprintf("mkdir %s: %v", target, err))
						return
					}
					madeDirs[target] = true
				}
			}
			err = sshsvc.SFTPUpload(sc, target, name, part)
			part.Close()
			if err != nil {
				writeErr(w, http.StatusBadGateway, fmt.Sprintf("upload %s: %v", rel, err))
				return
			}
			uploaded = append(uploaded, rel)
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
	if r.URL.Query().Get("inline") == "1" {
		// Image preview: serve with a real image type so <img> can show it.
		// The restrictive CSP keeps an SVG from running scripts if someone
		// opens the URL directly.
		ct, ok := previewTypes[strings.ToLower(stdpath.Ext(name))]
		if !ok {
			writeErr(w, http.StatusUnsupportedMediaType, "not a previewable image")
			return
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Content-Disposition", "inline")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, strings.ReplaceAll(name, `"`, `'`)))
	}
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

// previewTypes lists the image formats the browser preview will serve.
var previewTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	".svg":  "image/svg+xml",
}

// rawUploadName returns the multipart filename exactly as the client sent
// it. Part.FileName() would strip any directory part, which is precisely
// what folder upload needs to keep.
func rawUploadName(p *multipart.Part) string {
	if _, params, err := mime.ParseMediaType(p.Header.Get("Content-Disposition")); err == nil {
		if fn := params["filename"]; fn != "" {
			return fn
		}
	}
	return p.FileName()
}

// uploadRelPath reduces a client-supplied filename to a clean relative
// path: forward slashes only, no leading slash, and no "." or ".." parts,
// so an upload can never escape the target directory.
func uploadRelPath(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	parts := []string{}
	for _, seg := range strings.Split(name, "/") {
		if seg == "" || seg == "." || seg == ".." {
			continue
		}
		parts = append(parts, seg)
	}
	return strings.Join(parts, "/")
}

// maxBatchItems caps how many paths one batch/archive request may carry.
const maxBatchItems = 5000

// refusedPath reports paths a batch operation must never touch.
func refusedPath(p string) bool {
	c := stdpath.Clean(strings.TrimSpace(p))
	return p == "" || c == "." || c == "/" || c == ".."
}

type batchFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// sftpBatch runs copy / move / remove over many paths on one SFTP
// connection. A failing item does not stop the others: every item is
// attempted and the failures are reported together, so whatever succeeded
// stays done.
//
//	POST {"op":"copy|move|remove","paths":[...],"dest":"/target/dir"}
//	-> {"op":..,"total":N,"done":K,"failures":[{"path":..,"error":..}]}
func (s *Server) sftpBatch(w http.ResponseWriter, r *http.Request, sc *sftp.Client) {
	var in struct {
		Op    string   `json:"op"`
		Paths []string `json:"paths"`
		Dest  string   `json:"dest"`
	}
	if err := decodeJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if in.Op != "copy" && in.Op != "move" && in.Op != "remove" {
		writeErr(w, http.StatusBadRequest, "op must be copy, move or remove")
		return
	}
	if len(in.Paths) == 0 {
		writeErr(w, http.StatusBadRequest, "paths is required")
		return
	}
	if len(in.Paths) > maxBatchItems {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("too many items (max %d)", maxBatchItems))
		return
	}

	dest := ""
	if in.Op != "remove" {
		if in.Dest == "" {
			writeErr(w, http.StatusBadRequest, "dest is required")
			return
		}
		dest = stdpath.Clean(in.Dest)
		if fi, err := sc.Stat(dest); err != nil {
			writeErr(w, http.StatusBadGateway, "destination: "+err.Error())
			return
		} else if !fi.IsDir() {
			writeErr(w, http.StatusBadRequest, "destination is not a folder")
			return
		}
	}

	failures := []batchFailure{}
	done := 0
	for _, p := range in.Paths {
		// The browser went away (tab closed / navigated): stop starting new
		// items. Items already finished stay finished.
		if r.Context().Err() != nil {
			failures = append(failures, batchFailure{Path: p, Error: "cancelled"})
			continue
		}
		if refusedPath(p) {
			failures = append(failures, batchFailure{Path: p, Error: "refusing to touch root/empty path"})
			continue
		}
		p = stdpath.Clean(p)

		var err error
		switch in.Op {
		case "remove":
			err = sshsvc.SFTPRemoveAll(sc, p)
		case "copy", "move":
			name := stdpath.Base(p)
			// Pasting a copy into the folder it came from would collide
			// with itself, so give the duplicate a fresh name instead.
			if in.Op == "copy" && stdpath.Dir(p) == dest {
				name = sshsvc.UniqueCopyName(sc, dest, name)
			}
			target := stdpath.Join(dest, name)
			if in.Op == "copy" {
				err = sshsvc.SFTPCopy(sc, p, target)
			} else {
				err = sshsvc.SFTPMove(sc, p, target)
			}
		}
		if err != nil {
			failures = append(failures, batchFailure{Path: p, Error: err.Error()})
			continue
		}
		done++
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"op":       in.Op,
		"total":    len(in.Paths),
		"done":     done,
		"failures": failures,
	})
}

// sftpArchive streams the selected files/folders back as one zip. It is a
// POST (form field "paths" = JSON array, optional "name") because a large
// selection would not fit in a URL; the browser submits it with a hidden
// form so the download is streamed straight to disk, not buffered in memory.
// Entries that cannot be read are skipped and listed in _download_errors.txt
// inside the zip.
func (s *Server) sftpArchive(w http.ResponseWriter, r *http.Request, sess model.Session) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := r.ParseForm(); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid form body")
		return
	}
	var paths []string
	if err := json.Unmarshal([]byte(r.PostFormValue("paths")), &paths); err != nil || len(paths) == 0 {
		writeErr(w, http.StatusBadRequest, "paths is required")
		return
	}
	if len(paths) > maxBatchItems {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("too many items (max %d)", maxBatchItems))
		return
	}
	for _, p := range paths {
		if refusedPath(p) {
			writeErr(w, http.StatusBadRequest, "refusing to archive root/empty path")
			return
		}
	}

	name := stdpath.Base(strings.ReplaceAll(r.PostFormValue("name"), "\\", "/"))
	if name == "" || name == "." || name == "/" {
		name = "download"
	}
	if !strings.HasSuffix(strings.ToLower(name), ".zip") {
		name += ".zip"
	}

	client, sc, err := sshsvc.DialSFTP(sess)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	defer sc.Close()
	defer client.Close()

	// Fail before any byte of the zip is sent if a path is already gone;
	// once streaming has started the status can no longer change.
	for _, p := range paths {
		if _, err := sc.Lstat(stdpath.Clean(p)); err != nil {
			writeErr(w, http.StatusNotFound, fmt.Sprintf("%s: %v", p, err))
			return
		}
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	zw := zip.NewWriter(w)
	var problems []string
	for _, p := range paths {
		p = stdpath.Clean(p)
		zipAdd(r, sc, zw, p, stdpath.Base(p), &problems)
	}
	if len(problems) > 0 {
		if fw, err := zw.Create("_download_errors.txt"); err == nil {
			_, _ = io.WriteString(fw, strings.Join(problems, "\n")+"\n")
		}
	}
	_ = zw.Close()
}

// zipAdd adds the remote file/folder at remote to zw under zipName, noting
// anything it had to skip in problems.
func zipAdd(r *http.Request, sc *sftp.Client, zw *zip.Writer, remote, zipName string, problems *[]string) {
	if r.Context().Err() != nil {
		return
	}
	fi, err := sc.Lstat(remote)
	if err != nil {
		*problems = append(*problems, fmt.Sprintf("%s: %v", remote, err))
		return
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		// Include what a link to a file points at; links to folders are
		// skipped (they could loop back into the tree being archived).
		st, err := sc.Stat(remote)
		if err != nil {
			*problems = append(*problems, fmt.Sprintf("%s: broken symlink: %v", remote, err))
			return
		}
		if st.IsDir() {
			*problems = append(*problems, fmt.Sprintf("%s: symlink to a folder skipped", remote))
			return
		}
		fi = st
	}

	if fi.IsDir() {
		hdr := &zip.FileHeader{Name: zipName + "/", Method: zip.Store}
		hdr.Modified = fi.ModTime()
		hdr.SetMode(fi.Mode().Perm() | os.ModeDir)
		if _, err := zw.CreateHeader(hdr); err != nil {
			return
		}
		entries, err := sc.ReadDir(remote)
		if err != nil {
			*problems = append(*problems, fmt.Sprintf("%s: %v", remote, err))
			return
		}
		for _, e := range entries {
			zipAdd(r, sc, zw, stdpath.Join(remote, e.Name()), zipName+"/"+e.Name(), problems)
		}
		return
	}

	if !fi.Mode().IsRegular() {
		*problems = append(*problems, fmt.Sprintf("%s: unsupported file type skipped", remote))
		return
	}
	f, err := sc.Open(remote)
	if err != nil {
		*problems = append(*problems, fmt.Sprintf("%s: %v", remote, err))
		return
	}
	defer f.Close()
	hdr := &zip.FileHeader{Name: zipName, Method: zip.Deflate}
	hdr.Modified = fi.ModTime()
	hdr.SetMode(fi.Mode().Perm())
	fw, err := zw.CreateHeader(hdr)
	if err != nil {
		return
	}
	if _, err := io.Copy(fw, f); err != nil {
		*problems = append(*problems, fmt.Sprintf("%s: read failed part-way, file is truncated: %v", remote, err))
	}
}
