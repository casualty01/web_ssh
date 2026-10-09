package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"webssh/internal/model"
	"webssh/internal/store"
)

const cookieName = "webssh_token"
const tokenTTL = 24 * time.Hour

type authGuard struct {
	mu     sync.Mutex
	tokens map[string]time.Time
	store  *store.Store

	// envUser/envPass are the bootstrap credentials taken from
	// ADMIN_USER / ADMIN_PASSWORD (default admin/admin). They are only
	// used until an admin password has been set via the API, at which
	// point the persisted, hashed credentials in the store take over.
	envUser string
	envPass string
}

func newAuthGuard(st *store.Store) *authGuard {
	u := os.Getenv("ADMIN_USER")
	p := os.Getenv("ADMIN_PASSWORD")
	if u == "" {
		u = "admin"
	}
	if p == "" {
		p = "admin"
	}
	return &authGuard{tokens: map[string]time.Time{}, store: st, envUser: u, envPass: p}
}

func newToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func newSalt() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func hashPassword(password, salt string) string {
	sum := sha256.Sum256([]byte(salt + ":" + password))
	return hex.EncodeToString(sum[:])
}

// currentUsername returns the username that should be used to log in right
// now: the persisted one if a password has been set, otherwise the
// env-configured bootstrap username.
func (a *authGuard) currentUsername() string {
	if admin, ok := a.store.GetAdmin(); ok {
		return admin.Username
	}
	return a.envUser
}

// checkPassword verifies a candidate username/password pair against the
// current admin credentials, in constant time.
func (a *authGuard) checkPassword(username, password string) bool {
	if admin, ok := a.store.GetAdmin(); ok {
		okUser := subtle.ConstantTimeCompare([]byte(username), []byte(admin.Username)) == 1
		candidate := hashPassword(password, admin.Salt)
		okPass := subtle.ConstantTimeCompare([]byte(candidate), []byte(admin.PasswordHash)) == 1
		return okUser && okPass
	}
	okUser := subtle.ConstantTimeCompare([]byte(username), []byte(a.envUser)) == 1
	okPass := subtle.ConstantTimeCompare([]byte(password), []byte(a.envPass)) == 1
	return okUser && okPass
}

func (a *authGuard) login(w http.ResponseWriter, r *http.Request) {
	var req struct{ Username, Password string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !a.checkPassword(req.Username, req.Password) {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	tok := newToken()
	a.mu.Lock()
	a.tokens[tok] = time.Now().Add(tokenTTL)
	a.mu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    tok,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(tokenTTL),
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *authGuard) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		a.mu.Lock()
		delete(a.tokens, c.Value)
		a.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *authGuard) valid(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	exp, ok := a.tokens[c.Value]
	if !ok || time.Now().After(exp) {
		return false
	}
	return true
}

func (a *authGuard) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.valid(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// changePassword handles POST /api/admin/password. The caller must already
// be authenticated (this sits behind authGuard.middleware) AND must supply
// the current password as extra confirmation. On success the new,
// salted-hash credentials are persisted to disk and every existing session
// — including the caller's — is invalidated so everyone has to sign back
// in with the new password.
func (a *authGuard) changePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewUsername     string `json:"newUsername"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}

	if !a.checkPassword(a.currentUsername(), req.CurrentPassword) {
		// 403, not 401: a wrong "current password" here must not be treated
		// like an expired session by the frontend's global 401 handler.
		writeErr(w, http.StatusForbidden, "current password is incorrect")
		return
	}

	newUsername := strings.TrimSpace(req.NewUsername)
	if newUsername == "" {
		newUsername = a.currentUsername()
	}
	if len(req.NewPassword) < 6 {
		writeErr(w, http.StatusBadRequest, "new password must be at least 6 characters")
		return
	}

	salt := newSalt()
	admin := model.AdminAuth{
		Username:     newUsername,
		PasswordHash: hashPassword(req.NewPassword, salt),
		Salt:         salt,
	}
	if err := a.store.SetAdmin(admin); err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to save new credentials")
		return
	}

	// Force everyone (including this session) to sign back in with the
	// new credentials.
	a.mu.Lock()
	a.tokens = map[string]time.Time{}
	a.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1})

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
