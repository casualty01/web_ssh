package sshsvc

import (
	"fmt"
	"io"
	"os"
	stdpath "path"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"webssh/internal/model"
)

// SFTPEntry describes one file/directory row for the browser UI.
type SFTPEntry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	IsDir   bool      `json:"isDir"`
	IsLink  bool      `json:"isLink"`
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"`
	ModTime time.Time `json:"modTime"`
}

// DialSFTP opens a fresh SSH connection for the session and layers an SFTP
// client on top. Callers must Close() both when done (Close the *sftp.Client
// first, then the *ssh.Client).
func DialSFTP(sess model.Session) (*ssh.Client, *sftp.Client, error) {
	client, err := Dial(sess)
	if err != nil {
		return nil, nil, err
	}
	sc, err := sftp.NewClient(client)
	if err != nil {
		client.Close()
		return nil, nil, fmt.Errorf("start sftp subsystem: %w", err)
	}
	return client, sc, nil
}

func cleanPath(p string) string {
	if p == "" {
		return "."
	}
	return stdpath.Clean(p)
}

// SFTPList lists a directory's immediate children.
func SFTPList(sc *sftp.Client, dir string) ([]SFTPEntry, error) {
	dir = cleanPath(dir)
	infos, err := sc.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]SFTPEntry, 0, len(infos))
	for _, fi := range infos {
		out = append(out, SFTPEntry{
			Name:    fi.Name(),
			Path:    stdpath.Join(dir, fi.Name()),
			IsDir:   fi.IsDir(),
			IsLink:  fi.Mode()&os.ModeSymlink != 0,
			Size:    fi.Size(),
			Mode:    fi.Mode().String(),
			ModTime: fi.ModTime(),
		})
	}
	return out, nil
}

// SFTPMkdir creates a directory (and any missing parents).
func SFTPMkdir(sc *sftp.Client, dir string) error {
	return sc.MkdirAll(cleanPath(dir))
}

// SFTPRename renames/moves a remote path.
func SFTPRename(sc *sftp.Client, oldPath, newPath string) error {
	return sc.Rename(cleanPath(oldPath), cleanPath(newPath))
}

// SFTPRemoveAll deletes a file, or recursively deletes a directory.
func SFTPRemoveAll(sc *sftp.Client, p string) error {
	p = cleanPath(p)
	fi, err := sc.Stat(p)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return sc.Remove(p)
	}
	entries, err := sc.ReadDir(p)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := SFTPRemoveAll(sc, stdpath.Join(p, e.Name())); err != nil {
			return err
		}
	}
	return sc.RemoveDirectory(p)
}

// SFTPUpload streams src into a new/overwritten remote file at dir/filename.
// If the transfer fails or is cancelled part-way, the partial remote file is
// removed so a truncated upload isn't mistaken for a complete one.
func SFTPUpload(sc *sftp.Client, dir, filename string, src io.Reader) error {
	dst := stdpath.Join(cleanPath(dir), filename)
	f, err := sc.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, src); err != nil {
		f.Close()
		_ = sc.Remove(dst)
		return err
	}
	// Close flushes outstanding writes and can report a late failure
	// (e.g. disk full), so its error matters.
	return f.Close()
}

// SFTPDownload opens a remote file for reading; caller must Close() it.
func SFTPDownload(sc *sftp.Client, p string) (*sftp.File, error) {
	return sc.Open(cleanPath(p))
}
