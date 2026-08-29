//nolint:tagliatelle // Persisted backup cache schemas retain their existing camelCase keys.
package gmailbackup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var (
	errCacheRootNotAbsolute      = errors.New("gmail backup cache root must be absolute")
	errCacheMessageIDMismatch    = errors.New("gmail backup cache message ID mismatch")
	errCacheMessageRawEmpty      = errors.New("gmail backup cache message raw payload is empty")
	errCacheMessagePathMissing   = errors.New("gmail backup cache message path unavailable")
	errCacheListStatePathMissing = errors.New("gmail backup cache list state path unavailable")
)

type Message struct {
	ID           string   `json:"id"`
	ThreadID     string   `json:"threadId,omitempty"`
	HistoryID    string   `json:"historyId,omitempty"`
	InternalDate int64    `json:"internalDate,omitempty"`
	LabelIDs     []string `json:"labelIds,omitempty"`
	SizeEstimate int64    `json:"sizeEstimate,omitempty"`
	Raw          string   `json:"raw"`
}

type Selection struct {
	AccountHash      string
	Query            string
	Max              int64
	IncludeSpamTrash bool
}

type ListState struct {
	Version          int       `json:"version"`
	AccountHash      string    `json:"accountHash"`
	Query            string    `json:"query,omitempty"`
	Max              int64     `json:"max,omitempty"`
	IncludeSpamTrash bool      `json:"includeSpamTrash"`
	PageToken        string    `json:"pageToken,omitempty"`
	IDs              []string  `json:"ids"`
	Complete         bool      `json:"complete"`
	Updated          time.Time `json:"updated"`
}

type Cache struct {
	root string
}

func NewCache(root string) (Cache, error) {
	root = strings.TrimSpace(root)
	if root == "" || !filepath.IsAbs(root) {
		return Cache{}, errCacheRootNotAbsolute
	}

	return Cache{root: filepath.Clean(root)}, nil
}

func (c Cache) Configured() bool {
	return c.root != ""
}

func (c Cache) MessagePath(accountHash, messageID string) (string, bool) {
	accountHash, ok := safeSegment(accountHash)
	messageID = strings.TrimSpace(messageID)

	if !c.Configured() || !ok || messageID == "" {
		return "", false
	}
	sum := sha256.Sum256([]byte(messageID))
	name := hex.EncodeToString(sum[:]) + ".json"

	return filepath.Join(c.root, "backup", "gmail", accountHash, "raw-v1", name), true
}

func (c Cache) ReadMessage(accountHash, messageID string) (Message, bool, error) {
	path, ok := c.MessagePath(accountHash, messageID)
	if !ok {
		return Message{}, false, nil
	}

	data, err := os.ReadFile(path) //nolint:gosec // path is rooted in the injected cache and uses hashed message IDs.
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Message{}, false, nil
		}

		return Message{}, false, fmt.Errorf("read gmail backup cache %s: %w", path, err)
	}

	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		return Message{}, false, fmt.Errorf("decode gmail backup cache %s: %w", path, err)
	}

	if msg.ID != messageID {
		return Message{}, false, fmt.Errorf("%w: %s has id %q, want %q", errCacheMessageIDMismatch, path, msg.ID, messageID)
	}

	if strings.TrimSpace(msg.Raw) == "" {
		return Message{}, false, fmt.Errorf("%w: %s", errCacheMessageRawEmpty, path)
	}

	return msg, true, nil
}

func (c Cache) WriteMessage(accountHash string, msg Message) error {
	if strings.TrimSpace(msg.ID) == "" {
		return nil
	}
	path, ok := c.MessagePath(accountHash, msg.ID)

	if !ok {
		return errCacheMessagePathMissing
	}

	if err := writePrivateJSON(path, ".message-*.json", msg); err != nil {
		return fmt.Errorf("write gmail backup cache %s: %w", msg.ID, err)
	}

	return nil
}

func (c Cache) ListStatePath(selection Selection) (string, bool) {
	accountHash, ok := safeSegment(selection.AccountHash)
	if !c.Configured() || !ok {
		return "", false
	}
	key := struct {
		Query            string `json:"query,omitempty"`
		Max              int64  `json:"max,omitempty"`
		IncludeSpamTrash bool   `json:"includeSpamTrash"`
	}{
		Query:            strings.TrimSpace(selection.Query),
		Max:              selection.Max,
		IncludeSpamTrash: selection.IncludeSpamTrash,
	}

	data, err := json.Marshal(key)
	if err != nil {
		return "", false
	}
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:]) + ".json"

	return filepath.Join(c.root, "backup", "gmail", accountHash, "list-v1", name), true
}

func (c Cache) ReadListState(selection Selection) (ListState, bool, error) {
	path, ok := c.ListStatePath(selection)
	if !ok {
		return ListState{}, false, nil
	}

	data, err := os.ReadFile(path) //nolint:gosec // path is rooted in the injected cache and uses a selection hash.
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ListState{}, false, nil
		}

		return ListState{}, false, fmt.Errorf("read gmail backup list state %s: %w", path, err)
	}

	var state ListState
	if err := json.Unmarshal(data, &state); err != nil {
		return ListState{}, false, fmt.Errorf("decode gmail backup list state %s: %w", path, err)
	}

	if state.Version != 1 {
		return ListState{}, false, nil
	}

	return state, true, nil
}

func (c Cache) WriteListState(selection Selection, ids []string, pageToken string, complete bool) error {
	path, ok := c.ListStatePath(selection)
	if !ok {
		return errCacheListStatePathMissing
	}

	state := ListState{
		Version:          1,
		AccountHash:      strings.TrimSpace(selection.AccountHash),
		Query:            strings.TrimSpace(selection.Query),
		Max:              selection.Max,
		IncludeSpamTrash: selection.IncludeSpamTrash,
		PageToken:        pageToken,
		IDs:              append([]string(nil), ids...),
		Complete:         complete,
		Updated:          time.Now().UTC(),
	}

	if err := writePrivateJSON(path, ".list-*.json", state); err != nil {
		return fmt.Errorf("write gmail backup list state: %w", err)
	}

	return nil
}

func (c Cache) MessageShardDir(accountHash string) (string, bool) {
	accountHash, ok := safeSegment(accountHash)
	if !c.Configured() || !ok {
		return "", false
	}

	return filepath.Join(c.root, "backup", "gmail", accountHash, "tmp-shards"), true
}

func (c Cache) CheckpointShardDir(accountHash, runID string) (string, bool) {
	accountHash, accountOK := safeSegment(accountHash)
	runID, runOK := safeSegment(runID)

	if !c.Configured() || !accountOK || !runOK {
		return "", false
	}

	return filepath.Join(c.root, "backup", "gmail", accountHash, "checkpoint-shards", runID), true
}

func safeSegment(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || value == "." || value == ".." ||
		strings.ContainsAny(value, `/\`) ||
		filepath.Base(value) != value {
		return "", false
	}

	return value, true
}

func writePrivateJSON(path, pattern string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}

	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode JSON: %w", err)
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), pattern)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()

	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}

	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return fmt.Errorf("write temp file: %w", err)
	}

	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", err)
	}

	if err := os.Chmod(tmpPath, 0o600); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("chmod temp file: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("replace %s: %w", path, err)
	}

	return nil
}
