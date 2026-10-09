package httpapi

import (
	"net/http"
	"strings"

	"webssh/internal/sshsvc"
	"webssh/internal/store"
)

type Server struct {
	store   *store.Store
	tunnels *sshsvc.TunnelManager
	terms   *termManager
	auth    *authGuard
	webDir  string
	version string
}

func NewServer(st *store.Store, tm *sshsvc.TunnelManager, webDir string, version string) *Server {
	if version == "" {
		version = "dev"
	}
	return &Server{store: st, tunnels: tm, terms: newTermManager(), auth: newAuthGuard(st), webDir: webDir, version: version}
}

func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()

	// -- auth (unauthenticated) --
	mux.HandleFunc("/api/login", s.auth.login)
	mux.HandleFunc("/api/logout", s.auth.logout)
	mux.HandleFunc("/api/me", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"authenticated": s.auth.valid(r)})
	})
	// Unauthenticated on purpose: lets you (or the login page itself)
	// confirm which build the server is actually running — e.g.
	// `curl http://host:8080/api/version` — without needing to sign in
	// first, which is exactly the case when you suspect a stale deploy.
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"version": s.version})
	})

	// -- protected API --
	api := http.NewServeMux()
	api.HandleFunc("/api/groups", s.handleGroups)
	api.HandleFunc("/api/groups/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/api/groups/")
		if id == "" {
			http.NotFound(w, r)
			return
		}
		s.handleGroupByID(w, r, id)
	})
	api.HandleFunc("/api/sessions", s.handleSessions)
	api.HandleFunc("/api/sessions/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
		if id == "" {
			http.NotFound(w, r)
			return
		}
		s.handleSessionByID(w, r, id)
	})
	api.HandleFunc("/api/tunnels", s.handleTunnels)
	api.HandleFunc("/api/tunnels/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/tunnels/")
		if rest == "" {
			http.NotFound(w, r)
			return
		}
		s.handleTunnelByID(w, r, rest)
	})
	api.HandleFunc("/api/sftp/", func(w http.ResponseWriter, r *http.Request) {
		s.handleSFTP(w, r)
	})
	api.HandleFunc("/api/admin/password", s.auth.changePassword)
	mux.Handle("/api/", s.auth.middleware(api))

	// -- protected WebSocket --
	wsMux := http.NewServeMux()
	wsMux.HandleFunc("/ws/ssh", s.handleWSSSH)
	mux.Handle("/ws/", s.auth.middleware(wsMux))

	// -- static web client --
	// Cache-Control: no-cache forces the browser to always revalidate with
	// the server (a cheap conditional GET honoring Last-Modified/ETag,
	// answered with 304 when nothing changed) instead of silently serving
	// a stale, previously-cached app.js/index.html after a deploy.
	mux.Handle("/", noCache(http.FileServer(http.Dir(s.webDir))))

	return mux
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}
