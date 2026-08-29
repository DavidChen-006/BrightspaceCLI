//nolint:wsl_v5
package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseGoogleOAuthClientJSON(t *testing.T) {
	t.Run("installed", func(t *testing.T) {
		got, err := ParseGoogleOAuthClientJSON([]byte(`{"installed":{"client_id":"id","client_secret":"sec"}}`))
		if err != nil {
			t.Fatalf("err: %v", err)
		}

		if got.ClientID != "id" || got.ClientSecret != "sec" {
			t.Fatalf("unexpected: %#v", got)
		}
	})

	t.Run("web", func(t *testing.T) {
		got, err := ParseGoogleOAuthClientJSON([]byte(`{"web":{"client_id":"id","client_secret":"sec"}}`))
		if err != nil {
			t.Fatalf("err: %v", err)
		}

		if got.ClientID != "id" || got.ClientSecret != "sec" {
			t.Fatalf("unexpected: %#v", got)
		}
	})

	t.Run("invalid", func(t *testing.T) {
		_, err := ParseGoogleOAuthClientJSON([]byte(`{"nope":{}}`))
		if err == nil {
			t.Fatalf("expected error")
		}
	})

	t.Run("invalid json", func(t *testing.T) {
		if _, err := ParseGoogleOAuthClientJSON([]byte("{")); err == nil {
			t.Fatalf("expected error")
		}
	})

	t.Run("expand env opt in", func(t *testing.T) {
		t.Setenv("GOG_TEST_CLIENT_ID", "id-env")
		t.Setenv("GOG_TEST_CLIENT_SECRET", "sec-env")
		got, err := ParseGoogleOAuthClientJSONWithOptions(
			[]byte(`{"installed":{"client_id":"${GOG_TEST_CLIENT_ID}","client_secret":"${GOG_TEST_CLIENT_SECRET:-fallback}"}}`),
			ParseGoogleOAuthClientJSONOptions{ExpandEnv: true},
		)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if got.ClientID != "id-env" || got.ClientSecret != "sec-env" {
			t.Fatalf("unexpected expanded credentials: %#v", got)
		}
	})

	t.Run("expand env fallback", func(t *testing.T) {
		got, err := ParseGoogleOAuthClientJSONWithOptions(
			[]byte(`{"installed":{"client_id":"id","client_secret":"${GOG_TEST_MISSING_SECRET:-fallback-secret}"}}`),
			ParseGoogleOAuthClientJSONOptions{ExpandEnv: true},
		)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if got.ClientSecret != "fallback-secret" {
			t.Fatalf("unexpected fallback: %#v", got)
		}
	})

	t.Run("expand env missing strict", func(t *testing.T) {
		_, err := ParseGoogleOAuthClientJSONWithOptions(
			[]byte(`{"installed":{"client_id":"id","client_secret":"${GOG_TEST_MISSING_SECRET}"}}`),
			ParseGoogleOAuthClientJSONOptions{ExpandEnv: true},
		)
		if err == nil || !strings.Contains(err.Error(), "GOG_TEST_MISSING_SECRET") {
			t.Fatalf("expected missing env error, got %v", err)
		}
	})
}

func TestClientCredentials_Roundtrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))

	store := testClientCredentialsStore(t)
	in := ClientCredentials{ClientID: "id", ClientSecret: "secret"}
	if err := store.Write(DefaultClientName, in); err != nil {
		t.Fatalf("Write: %v", err)
	}

	p, err := store.PathFor(DefaultClientName)
	if err != nil {
		t.Fatalf("ClientCredentialsPath: %v", err)
	}

	if filepath.Base(p) != "credentials.json" {
		t.Fatalf("unexpected base: %q", filepath.Base(p))
	}

	if _, statErr := os.Stat(p); statErr != nil {
		t.Fatalf("stat credentials: %v", statErr)
	}

	out, err := store.Read(DefaultClientName)
	if err != nil {
		t.Fatalf("ReadClientCredentials: %v", err)
	}

	if out.ClientID != in.ClientID || out.ClientSecret != in.ClientSecret {
		t.Fatalf("mismatch: %#v != %#v", out, in)
	}
}

func TestClientCredentials_MetadataRoundtrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))

	store := testClientCredentialsStore(t)
	in := ClientCredentials{ClientID: "id", ClientSecret: "secret"}
	if err := store.WriteMetadata("work", in); err != nil {
		t.Fatalf("WriteMetadata: %v", err)
	}

	metadata, err := store.ReadMetadata("work")
	if err != nil {
		t.Fatalf("ReadClientCredentialsMetadataFor: %v", err)
	}
	if metadata.ClientID != "id" || metadata.ClientSecret != "" {
		t.Fatalf("unexpected metadata: %#v", metadata)
	}

	if _, err := store.Read("work"); err == nil {
		t.Fatalf("expected full credentials read to reject missing secret")
	}
}

func TestReadClientCredentials_Errors(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))

	store := testClientCredentialsStore(t)
	_, err := store.Read(DefaultClientName)
	if err == nil {
		t.Fatalf("expected error")
	}
	var missingErr *CredentialsMissingError

	if !errors.As(err, &missingErr) {
		t.Fatalf("expected CredentialsMissingError, got %T", err)
	}

	path, pathErr := store.PathFor(DefaultClientName)
	if pathErr != nil {
		t.Fatalf("ClientCredentialsPath: %v", pathErr)
	}

	if dirErr := os.MkdirAll(store.layout.DataDir, 0o700); dirErr != nil {
		t.Fatalf("ensure data dir: %v", dirErr)
	}

	if writeErr := os.WriteFile(path, []byte(`{"client_id":""}`), 0o600); writeErr != nil {
		t.Fatalf("write: %v", writeErr)
	}

	if _, err := store.Read(DefaultClientName); err == nil {
		t.Fatalf("expected missing field error")
	}
}

func TestReadClientCredentials_LegacyConfigFallback(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "xdg-data"))

	store := testClientCredentialsStore(t)
	legacyPath, err := store.legacyPathFor("work")
	if err != nil {
		t.Fatalf("LegacyClientCredentialsPathFor: %v", err)
	}
	if mkdirErr := os.MkdirAll(filepath.Dir(legacyPath), 0o700); mkdirErr != nil {
		t.Fatalf("mkdir legacy: %v", mkdirErr)
	}
	if writeErr := os.WriteFile(legacyPath, []byte(`{"client_id":"legacy","client_secret":"secret"}`), 0o600); writeErr != nil {
		t.Fatalf("write legacy: %v", writeErr)
	}

	creds, err := store.Read("work")
	if err != nil {
		t.Fatalf("ReadClientCredentialsFor: %v", err)
	}
	if creds.ClientID != "legacy" || creds.ClientSecret != "secret" {
		t.Fatalf("unexpected credentials: %#v", creds)
	}

	primaryPath, err := store.PathFor("work")
	if err != nil {
		t.Fatalf("ClientCredentialsPathFor: %v", err)
	}
	if _, err := os.Stat(primaryPath); !os.IsNotExist(err) {
		t.Fatalf("expected primary missing, stat err: %v", err)
	}
}

func TestExistingClientCredentialsPathFor_LegacyConfigFallback(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "xdg-data"))

	store := testClientCredentialsStore(t)
	dir := store.layout.ConfigDir
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("ensure config dir: %v", err)
	}

	legacyPath := filepath.Join(dir, "credentials-work.json")
	if writeErr := os.WriteFile(legacyPath, []byte(`{"installed":{"client_id":"legacy","client_secret":"legacy-secret"}}`), 0o600); writeErr != nil {
		t.Fatalf("write legacy credentials: %v", writeErr)
	}

	got, exists, err := store.ExistingPath("work")
	if err != nil {
		t.Fatalf("ExistingClientCredentialsPathFor: %v", err)
	}
	if !exists {
		t.Fatalf("expected credentials to exist")
	}
	if got != legacyPath {
		t.Fatalf("got %q, want %q", got, legacyPath)
	}
}

func TestClientCredentialsExplicitDataSkipsLegacyFallback(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))
	t.Setenv("GOG_DATA_DIR", filepath.Join(home, "isolated-data"))

	store := testClientCredentialsStore(t)
	legacyPath, err := store.legacyPathFor("work")
	if err != nil {
		t.Fatalf("LegacyClientCredentialsPathFor: %v", err)
	}
	if mkdirErr := os.MkdirAll(filepath.Dir(legacyPath), 0o700); mkdirErr != nil {
		t.Fatalf("mkdir legacy: %v", mkdirErr)
	}
	if writeErr := os.WriteFile(legacyPath, []byte(`{"client_id":"legacy","client_secret":"secret"}`), 0o600); writeErr != nil {
		t.Fatalf("write legacy: %v", writeErr)
	}

	if _, readErr := store.Read("work"); readErr == nil {
		t.Fatalf("expected missing credentials with explicit data dir")
	}

	got, exists, err := store.ExistingPath("work")
	if err != nil {
		t.Fatalf("ExistingClientCredentialsPathFor: %v", err)
	}
	if exists {
		t.Fatalf("expected credentials to be isolated from legacy path")
	}
	if got == legacyPath {
		t.Fatalf("expected primary path, got legacy %q", got)
	}
}

func TestDeleteClientCredentialsExplicitDataKeepsLegacyFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))
	t.Setenv("GOG_DATA_DIR", filepath.Join(home, "isolated-data"))

	store := testClientCredentialsStore(t)
	legacyPath, err := store.legacyPathFor("work")
	if err != nil {
		t.Fatalf("LegacyClientCredentialsPathFor: %v", err)
	}
	if mkdirErr := os.MkdirAll(filepath.Dir(legacyPath), 0o700); mkdirErr != nil {
		t.Fatalf("mkdir legacy: %v", mkdirErr)
	}
	if writeErr := os.WriteFile(legacyPath, []byte(`{"client_id":"legacy","client_secret":"secret"}`), 0o600); writeErr != nil {
		t.Fatalf("write legacy: %v", writeErr)
	}

	if err := store.Delete("work"); err == nil {
		t.Fatalf("expected missing credentials with explicit data dir")
	}
	if _, statErr := os.Stat(legacyPath); statErr != nil {
		t.Fatalf("expected legacy file to remain, stat err: %v", statErr)
	}
}
