//nolint:wsl_v5 // Tests stay compact around setup/action/assert blocks.
package gmailbackup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewCacheRequiresAbsoluteRoot(t *testing.T) {
	t.Parallel()

	for _, root := range []string{"", "relative/cache"} {
		if _, err := NewCache(root); err == nil {
			t.Fatalf("NewCache(%q) succeeded", root)
		}
	}
}

func TestZeroCacheFailsClosed(t *testing.T) {
	t.Parallel()
	var cache Cache
	if cache.Configured() {
		t.Fatal("zero cache is configured")
	}

	if _, ok := cache.MessagePath("accthash", "m1"); ok {
		t.Fatal("zero cache returned a message path")
	}

	if err := cache.WriteMessage("accthash", Message{ID: "m1", Raw: "raw"}); err == nil {
		t.Fatal("zero cache accepted a write")
	}
}

func TestCacheMessageRoundTripUsesHashedInjectedPath(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cache, cacheErr := NewCache(root)
	if cacheErr != nil {
		t.Fatalf("NewCache: %v", cacheErr)
	}
	message := Message{ID: "msg-one", ThreadID: "thread-one", Raw: "raw"}
	if writeErr := cache.WriteMessage("accthash", message); writeErr != nil {
		t.Fatalf("WriteMessage: %v", writeErr)
	}
	got, ok, readErr := cache.ReadMessage("accthash", message.ID)
	if readErr != nil {
		t.Fatalf("ReadMessage: %v", readErr)
	}

	if !ok || got.ID != message.ID || got.ThreadID != message.ThreadID || got.Raw != message.Raw {
		t.Fatalf("message = %#v ok=%t", got, ok)
	}

	path, ok := cache.MessagePath("accthash", message.ID)
	if !ok {
		t.Fatal("MessagePath unavailable")
	}

	if !strings.HasPrefix(path, root+string(filepath.Separator)) {
		t.Fatalf("path %q is outside root %q", path, root)
	}
	if strings.Contains(path, message.ID) {
		t.Fatalf("path exposes message ID: %q", path)
	}
}

func TestCacheMessageRejectsWrongID(t *testing.T) {
	t.Parallel()
	cache, cacheErr := NewCache(t.TempDir())
	if cacheErr != nil {
		t.Fatalf("NewCache: %v", cacheErr)
	}
	path, ok := cache.MessagePath("accthash", "msg-one")
	if !ok {
		t.Fatal("MessagePath unavailable")
	}
	if mkdirErr := os.MkdirAll(filepath.Dir(path), 0o700); mkdirErr != nil {
		t.Fatalf("MkdirAll: %v", mkdirErr)
	}
	data, err := json.Marshal(Message{ID: "other", Raw: "raw"})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if _, _, err := cache.ReadMessage("accthash", "msg-one"); err == nil {
		t.Fatal("expected wrong cache ID to fail")
	}
}

func TestCacheListStateRoundTripAndSelectionIsolation(t *testing.T) {
	t.Parallel()

	cache, cacheErr := NewCache(t.TempDir())
	if cacheErr != nil {
		t.Fatalf("NewCache: %v", cacheErr)
	}
	selection := Selection{
		AccountHash:      "accthash",
		Query:            "in:inbox",
		Max:              10,
		IncludeSpamTrash: true,
	}
	if writeErr := cache.WriteListState(selection, []string{"m1"}, "next", false); writeErr != nil {
		t.Fatalf("WriteListState: %v", writeErr)
	}

	state, ok, err := cache.ReadListState(selection)
	if err != nil {
		t.Fatalf("ReadListState: %v", err)
	}

	if !ok || state.PageToken != "next" || len(state.IDs) != 1 || state.IDs[0] != "m1" {
		t.Fatalf("state = %#v ok=%t", state, ok)
	}
	other := selection
	other.Query = "in:sent"
	if _, ok, err := cache.ReadListState(other); err != nil || ok {
		t.Fatalf("other selection ok=%t err=%v", ok, err)
	}
}

func TestCacheShardDirsStayUnderInjectedRoot(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cache, err := NewCache(root)
	if err != nil {
		t.Fatalf("NewCache: %v", err)
	}
	messageDir, ok := cache.MessageShardDir("accthash")
	if !ok || !strings.HasPrefix(messageDir, root+string(filepath.Separator)) {
		t.Fatalf("message dir = %q ok=%t", messageDir, ok)
	}
	checkpointDir, ok := cache.CheckpointShardDir("accthash", "run-test")
	if !ok || !strings.HasPrefix(checkpointDir, root+string(filepath.Separator)) {
		t.Fatalf("checkpoint dir = %q ok=%t", checkpointDir, ok)
	}

	for _, invalid := range []string{"../escape", "nested/path", `nested\path`} {
		if _, ok := cache.MessageShardDir(invalid); ok {
			t.Fatalf("MessageShardDir(%q) succeeded", invalid)
		}

		if _, ok := cache.CheckpointShardDir("accthash", invalid); ok {
			t.Fatalf("CheckpointShardDir(%q) succeeded", invalid)
		}
	}
}
