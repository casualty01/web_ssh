package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"webssh/internal/model"
	"webssh/internal/store"
)

func (s *Server) handleTunnels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		list := s.store.ListTunnels()
		running := s.tunnels.Status()
		type withStatus struct {
			model.Tunnel
			Running bool `json:"running"`
		}
		out := make([]withStatus, 0, len(list))
		for _, t := range list {
			out = append(out, withStatus{Tunnel: t, Running: running[t.ID]})
		}
		writeJSON(w, http.StatusOK, out)
	case http.MethodPost:
		var in model.Tunnel
		if err := decodeJSON(r, &in); err != nil {
			writeErr(w, http.StatusBadRequest, "bad request")
			return
		}
		if strings.TrimSpace(in.Name) == "" || in.SessionID == "" {
			writeErr(w, http.StatusBadRequest, "name and sessionId are required")
			return
		}
		if _, err := s.store.GetSession(in.SessionID); err != nil {
			writeErr(w, http.StatusBadRequest, "sessionId does not reference an existing session")
			return
		}
		t, err := s.store.CreateTunnel(in)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, t)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleTunnelByID routes /api/tunnels/{id}[/start|/stop].
func (s *Server) handleTunnelByID(w http.ResponseWriter, r *http.Request, rest string) {
	id, action, _ := strings.Cut(rest, "/")
	if action != "" {
		switch action {
		case "start":
			s.startTunnel(w, r, id)
		case "stop":
			s.stopTunnel(w, r, id)
		default:
			writeErr(w, http.StatusNotFound, "unknown action")
		}
		return
	}

	switch r.Method {
	case http.MethodPut:
		var in model.Tunnel
		if err := decodeJSON(r, &in); err != nil {
			writeErr(w, http.StatusBadRequest, "bad request")
			return
		}
		t, err := s.store.UpdateTunnel(id, in)
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "tunnel not found")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, t)
	case http.MethodDelete:
		_ = s.tunnels.Stop(id) // best-effort; ignore "not running"
		if err := s.store.DeleteTunnel(id); errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "tunnel not found")
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

func (s *Server) startTunnel(w http.ResponseWriter, r *http.Request, id string) {
	t, err := s.store.GetTunnel(id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "tunnel not found")
		return
	}
	sess, err := s.store.GetSession(t.SessionID)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "owning session not found")
		return
	}
	if err := s.tunnels.Start(t, sess); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, model.TunnelStatus{TunnelID: id, Running: true})
}

func (s *Server) stopTunnel(w http.ResponseWriter, r *http.Request, id string) {
	if err := s.tunnels.Stop(id); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, model.TunnelStatus{TunnelID: id, Running: false})
}
