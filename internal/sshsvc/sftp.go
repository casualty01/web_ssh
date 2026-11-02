package sshsvc

import (
	"errors"
	"fmt"
	"io"
	"os"
	stdpath "path"
	"strings"
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
		full := stdpath.Join(dir, fi.Name())
		isDir := fi.IsDir()
		isLink := fi.Mode()&os.ModeSymlink != 0
		// ReadDir reports a symlink as a link, not as what it points at;
		// follow it so a link to a directory can still be browsed into.
		if isLink {
			if st, err := sc.Stat(full); err == nil && st.IsDir() {
				isDir = true
			}
		}
		out = append(out, SFTPEntry{
			Name:    fi.Name(),
			Path:    full,
			IsDir:   isDir,
			IsLink:  isLink,
			Size:    fi.Size(),
			Mode:    fi.Mode().String(),
			ModTime: fi.ModTime(),
		})
	}
	return out, nil
}

// SFTPRealPath resolves p (".", "~"-style relative paths, symlinks) to an
// absolute path on the remote host, so the browser can show clickable
// breadcrumbs for it.
func SFTPRealPath(sc *sftp.Client, p string) (string, error) {
	return sc.RealPath(cleanPath(p))
}

// SFTPMkdir creates a directory (and any missing parents).
func SFTPMkdir(sc *sftp.Client, dir string) error {
	return sc.MkdirAll(cleanPath(dir))
}

// SFTPRename renames/moves a remote path.
func SFTPRename(sc *sftp.Client, oldPath, newPath string) error {
	return sc.Rename(cleanPath(oldPath), cleanPath(newPath))
}

// SFTPRemoveAll deletes a file or symlink, or recursively deletes a
// directory. It uses Lstat on purpose: a symlink that points at a directory
// must be unlinked, never followed, or the contents of the link target would
// be wiped.
func SFTPRemoveAll(sc *sftp.Client, p string) error {
	p = cleanPath(p)
	fi, err := sc.Lstat(p)
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

// isInside reports whether child is parent itself or lies below it.
func isInside(parent, child string) bool {
	if parent == child {
		return true
	}
	if parent == "/" {
		return strings.HasPrefix(child, "/")
	}
	return strings.HasPrefix(child, parent+"/")
}

// joinErrs folds the errors of a recursive operation into one, keeping the
// message readable when thousands of entries fail for the same reason.
func joinErrs(errs []error) error {
	const keep = 3
	if len(errs) <= keep {
		return errors.Join(errs...)
	}
	more := fmt.Errorf("…and %d more errors", len(errs)-keep)
	return errors.Join(append(append([]error{}, errs[:keep]...), more)...)
}

// copyTree copies src to dst. dst must not exist yet. Regular files keep
// their permission bits, symlinks are re-created as symlinks, directories are
// copied recursively. A failure inside a directory does not stop its
// siblings; all failures are reported together.
func copyTree(sc *sftp.Client, src, dst string) error {
	fi, err := sc.Lstat(src)
	if err != nil {
		return err
	}
	mode := fi.Mode()
	switch {
	case mode&os.ModeSymlink != 0:
		target, err := sc.ReadLink(src)
		if err != nil {
			return err
		}
		return sc.Symlink(target, dst)

	case fi.IsDir():
		if err := sc.Mkdir(dst); err != nil {
			return err
		}
		entries, err := sc.ReadDir(src)
		if err != nil {
			return err
		}
		var errs []error
		for _, e := range entries {
			name := e.Name()
			if err := copyTree(sc, stdpath.Join(src, name), stdpath.Join(dst, name)); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", stdpath.Join(src, name), err))
			}
		}
		// Applied last so a read-only source directory can still be filled.
		_ = sc.Chmod(dst, mode.Perm())
		return joinErrs(errs)

	case mode&(os.ModeDevice|os.ModeCharDevice|os.ModeNamedPipe|os.ModeSocket) != 0:
		return errors.New("unsupported file type")

	default:
		in, err := sc.Open(src)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := sc.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			_ = sc.Remove(dst)
			return err
		}
		if err := out.Close(); err != nil {
			_ = sc.Remove(dst)
			return err
		}
		_ = sc.Chmod(dst, mode.Perm())
		return nil
	}
}

// checkTarget validates a copy/move from src to dst: they must differ, a
// folder can't go into itself, and dst must not already exist (nothing is
// ever overwritten silently).
func checkTarget(sc *sftp.Client, src, dst string) error {
	if src == dst {
		return errors.New("source and destination are the same")
	}
	if isInside(src, dst) {
		return errors.New("cannot copy or move a folder into itself")
	}
	if _, err := sc.Lstat(dst); err == nil {
		return errors.New("target already exists")
	}
	return nil
}

// SFTPCopy copies a file or folder tree from src to dst (dst must not exist).
func SFTPCopy(sc *sftp.Client, src, dst string) error {
	src, dst = cleanPath(src), cleanPath(dst)
	if err := checkTarget(sc, src, dst); err != nil {
		return err
	}
	return copyTree(sc, src, dst)
}

// SFTPMove moves src to dst (dst must not exist). It renames when it can; if
// the server refuses the rename (typically across filesystems) it falls back
// to copy + delete, and only deletes the source once the copy fully succeeded.
func SFTPMove(sc *sftp.Client, src, dst string) error {
	src, dst = cleanPath(src), cleanPath(dst)
	if err := checkTarget(sc, src, dst); err != nil {
		return err
	}
	renameErr := sc.Rename(src, dst)
	if renameErr == nil {
		return nil
	}
	if err := copyTree(sc, src, dst); err != nil {
		// dst did not exist before (checked above), so removing what the
		// partial copy left behind is safe.
		_ = SFTPRemoveAll(sc, dst)
		return fmt.Errorf("%v (copy fallback: %v)", renameErr, err)
	}
	if err := SFTPRemoveAll(sc, src); err != nil {
		return fmt.Errorf("copied to the target but could not delete the source: %w", err)
	}
	return nil
}

// UniqueCopyName returns a name for a duplicate of name that does not exist
// in dir yet: "a.txt" -> "a copy.txt", "a copy 2.txt", ...
func UniqueCopyName(sc *sftp.Client, dir, name string) string {
	ext := stdpath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	if stem == "" { // dotfile such as ".bashrc"
		stem, ext = name, ""
	}
	for i := 1; i < 10000; i++ {
		suffix := " copy"
		if i > 1 {
			suffix = fmt.Sprintf(" copy %d", i)
		}
		cand := stem + suffix + ext
		if _, err := sc.Lstat(stdpath.Join(dir, cand)); err != nil {
			return cand
		}
	}
	return name + " copy"
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
