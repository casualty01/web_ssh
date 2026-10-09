package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"webssh/internal/model"
	"webssh/internal/store"
)

func (s *Server) handleGroups(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.store.ListGroups())
	case http.MethodPost:
		var in model.Group
		if err := decodeJSON(r, &in); err != nil {
			writeErr(w, http.StatusBadRequest, "bad request")
			return
		}
		if strings.TrimSpace(in.Name) == "" {
			writeErr(w, http.StatusBadRequest, "name is required")
			return
		}
		g, err := s.store.CreateGroup(in)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, g)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleGroupByID handles /api/groups/{id} for rename (PUT, also used to
// move a group under a different parent) and delete.
func (s *Server) handleGroupByID(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodPut:
		var in model.Group
		if err := decodeJSON(r, &in); err != nil {
			writeErr(w, http.StatusBadRequest, "bad request")
			return
		}
		g, err := s.store.UpdateGroup(id, in.Name, in.ParentID)
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "group not found")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, g)
	case http.MethodDelete:
		if err := s.store.DeleteGroup(id); errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "group not found")
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
