package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestServiceAccountStoreRejectsIncompleteLayout(t *testing.T) {
	t.Parallel()

	store := NewServiceAccountStore(Layout{})
	if _, err := store.Write("user@example.com", []byte("{}")); !errors.Is(err, errIncompleteServiceAccountLayout) {
		t.Fatalf("Write error = %v", err)
	}

	if _, _, err := store.Read("user@example.com", true); !errors.Is(err, errIncompleteServiceAccountLayout) {
		t.Fatalf("Read error = %v", err)
	}

	if _, err := store.ListEmails(); !errors.Is(err, errIncompleteServiceAccountLayout) {
		t.Fatalf("ListEmails error = %v", err)
	}

	if _, err := store.Remove("user@example.com"); !errors.Is(err, errIncompleteServiceAccountLayout) {
		t.Fatalf("Remove error = %v", err)
	}
}

func TestServiceAccountStoreLookupOrder(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	layout := Layout{
		ConfigDir: filepath.Join(root, "config"),
		DataDir:   filepath.Join(root, "data"),
	}
	store := NewServiceAccountStore(layout)
	email := "User@Example.com"

	for _, dir := range []string{layout.ConfigDir, layout.DataDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}

	candidates := []struct {
		path         string
		data         string
		keepSpecific bool
	}{
		{path: layout.ServiceAccountPath(email), data: "generic-primary"},
		{path: layout.ServiceAccountLegacyPath(email), data: "generic-legacy"},
		{path: layout.KeepServiceAccountPath(email), data: "keep-primary", keepSpecific: true},
		{path: layout.KeepServiceAccountLegacySafePath(email), data: "keep-legacy-safe", keepSpecific: true},
		{path: layout.KeepServiceAccountLegacyPath(email), data: "keep-legacy-raw", keepSpecific: true},
	}

	for _, candidate := range candidates {
		if err := os.WriteFile(candidate.path, []byte(candidate.data), 0o600); err != nil {
			t.Fatalf("write %s: %v", candidate.path, err)
		}
	}

	for i, want := range candidates {
		file, exists, err := store.Read(email, true)
		if err != nil {
			t.Fatalf("read candidate %d: %v", i, err)
		}

		if !exists {
			t.Fatalf("candidate %d missing", i)
		}

		if file.Path != want.path || string(file.Data) != want.data || file.KeepSpecific != want.keepSpecific {
			t.Fatalf("candidate %d = %#v data=%q, want path=%q data=%q keep=%t", i, file, file.Data, want.path, want.data, want.keepSpecific)
		}

		if err := os.Remove(want.path); err != nil {
			t.Fatalf("remove %s: %v", want.path, err)
		}
	}

	file, exists, err := store.Read(email, true)
	if err != nil {
		t.Fatalf("read missing: %v", err)
	}

	if exists || file.Path != layout.ServiceAccountPath(email) {
		t.Fatalf("missing result = %#v exists=%t", file, exists)
	}
}

func TestServiceAccountStoreExplicitDataSuppressesLegacy(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	layout := Layout{
		ConfigDir:      filepath.Join(root, "config"),
		DataDir:        filepath.Join(root, "data"),
		ExplicitConfig: true,
		ExplicitData:   true,
	}
	store := NewServiceAccountStore(layout)
	email := "user@example.com"

	if err := os.MkdirAll(layout.ConfigDir, 0o700); err != nil {
		t.Fatalf("mkdir config: %v", err)
	}

	legacyPaths := []string{
		layout.ServiceAccountLegacyPath(email),
		layout.KeepServiceAccountLegacySafePath(email),
		layout.KeepServiceAccountLegacyPath(email),
	}
	for _, path := range legacyPaths {
		if err := os.WriteFile(path, []byte("legacy"), 0o600); err != nil {
			t.Fatalf("write legacy %s: %v", path, err)
		}
	}

	file, exists, err := store.Read(email, true)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	if exists || file.Path != layout.ServiceAccountPath(email) {
		t.Fatalf("Read = %#v exists=%t", file, exists)
	}

	emails, err := store.ListEmails()
	if err != nil {
		t.Fatalf("ListEmails: %v", err)
	}

	if len(emails) != 0 {
		t.Fatalf("ListEmails = %#v, want empty", emails)
	}

	removed, err := store.Remove(email)
	if err != nil {
		t.Fatalf("Remove: %v", err)
	}

	if removed {
		t.Fatal("Remove deleted a legacy file through an explicit data layout")
	}

	for _, path := range legacyPaths {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("legacy path %s changed: %v", path, err)
		}
	}
}

func TestServiceAccountStoreRawLegacyPathIsBounded(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	layout := Layout{
		ConfigDir: filepath.Join(root, "config"),
		DataDir:   filepath.Join(root, "data"),
	}
	store := NewServiceAccountStore(layout)

	if err := os.MkdirAll(layout.ConfigDir, 0o700); err != nil {
		t.Fatalf("mkdir config: %v", err)
	}

	victim := filepath.Join(layout.ConfigDir, "keep-sa-victim@example.com.json")
	if err := os.WriteFile(victim, []byte("victim"), 0o600); err != nil {
		t.Fatalf("write victim: %v", err)
	}

	if _, exists, err := store.Read("a/../victim@example.com", true); err != nil {
		t.Fatalf("Read: %v", err)
	} else if exists {
		t.Fatal("unsafe raw legacy path was read")
	}

	if removed, err := store.Remove("a/../victim@example.com"); err != nil {
		t.Fatalf("Remove: %v", err)
	} else if removed {
		t.Fatal("unsafe raw legacy path was removed")
	}

	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("victim changed: %v", err)
	}
}

func TestServiceAccountStoreWritesPrivateFilesAndListsOnce(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	store := NewServiceAccountStore(Layout{
		ConfigDir:      filepath.Join(root, "config"),
		DataDir:        filepath.Join(root, "data"),
		ExplicitConfig: true,
		ExplicitData:   true,
	})

	paths, err := store.WriteKeepCompatibility("User@Example.com", []byte(`{"type":"service_account"}`))
	if err != nil {
		t.Fatalf("WriteKeepCompatibility: %v", err)
	}

	if len(paths) != 2 {
		t.Fatalf("paths = %#v", paths)
	}

	for _, path := range paths {
		info, statErr := os.Stat(path)
		if statErr != nil {
			t.Fatalf("stat %s: %v", path, statErr)
		}

		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode = %o, want 600", path, info.Mode().Perm())
		}
	}

	emails, err := store.ListEmails()
	if err != nil {
		t.Fatalf("ListEmails: %v", err)
	}

	if len(emails) != 1 || emails[0] != "user@example.com" {
		t.Fatalf("ListEmails = %#v", emails)
	}
}
