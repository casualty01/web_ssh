package main

import (
	"log"
	"net/http"
	"os"
	"webssh/internal/httpapi"
	"webssh/internal/sshsvc"
	"webssh/internal/store"
)

// buildVersion identifies exactly which build is running. It's baked in at
// image-build time (see Dockerfile: -ldflags "-X main.buildVersion=...")
// so you can tell, just by loading the page (login screen, or GET
// /api/version), whether the server is actually serving the code you think
// it is — handy after a deploy when the browser might still have an old
// page/asset cached. Falls back to "dev" for `go run .` / local builds.
var buildVersion = "dev"

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	dataDir := getenv("DATA_DIR", "/data")
	webDir := getenv("WEB_DIR", "./web")
	addr := getenv("LISTEN_ADDR", ":8080")

	st, err := store.New(dataDir)
	if err != nil {
		log.Fatalf("failed to init store: %v", err)
	}

	tm := sshsvc.NewTunnelManager()
	defer tm.StopAll()

	srv := httpapi.NewServer(st, tm, webDir, buildVersion)

	log.Printf("webssh %s listening on %s (data dir: %s, web dir: %s)", buildVersion, addr, dataDir, webDir)
	if err := http.ListenAndServe(addr, srv.Router()); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
