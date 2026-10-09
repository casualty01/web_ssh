package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"webssh/internal/model"
	"webssh/internal/store"
)

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		list := s.store.ListSessions()
		out := make([]model.SessionPublic, 0, len(list))
		for _, sess := range list {
			out = append(out, sess.Public())
		}
		writeJSON(w, http.StatusOK, out)
	case http.MethodPost:
		var in model.Session
		if err := decodeJSON(r, &in); err != nil {
			writeErr(w, http.StatusBadRequest, "bad request")
			return
		}
		if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.Host) == "" || strings.TrimSpace(in.Username) == "" {
			writeErr(w, http.StatusBadRequest, "name, host and username are required")
			return
		}
		sess, err := s.store.CreateSession(in)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, sess.Public())
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleSessionByID handles /api/sessions/{id}: GET (full, for editing),
// PUT (update / rename / move to another group), DELETE.
func (s *Server) handleSessionByID(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		sess, err := s.store.GetSession(id)
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "session not found")
			return
		}
		writeJSON(w, http.StatusOK, sess.Public())
	case http.MethodPut:
		var in model.Session
		if err := decodeJSON(r, &in); err != nil {
			writeErr(w, http.StatusBadRequest, "bad request")
			return
		}
		sess, err := s.store.UpdateSession(id, in)
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "session not found")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, sess.Public())
	case http.MethodDelete:
		if err := s.store.DeleteSession(id); errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "session not found")
			return
		} else if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
