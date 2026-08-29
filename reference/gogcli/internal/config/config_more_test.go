package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigExists(t *testing.T) {
	t.Parallel()

	store := NewConfigStore(Layout{ConfigDir: t.TempDir()})

	exists, err := store.Exists()
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}

	if exists {
		t.Fatalf("expected config to be missing")
	}

	if writeErr := os.WriteFile(store.Path(), []byte(`{}`), 0o600); writeErr != nil {
		t.Fatalf("write config: %v", writeErr)
	}

	exists, err = store.Exists()
	if err != nil {
		t.Fatalf("Exists (after write): %v", err)
	}

	if !exists {
		t.Fatalf("expected config to exist")
	}
}

func TestKeepServiceAccountLegacyPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg"))

	path := testSystemLayout(t, PathKindConfig).KeepServiceAccountLegacyPath("User@Example.com")

	if !strings.Contains(path, "keep-sa-User@Example.com.json") {
		t.Fatalf("unexpected path: %q", path)
	}
}
