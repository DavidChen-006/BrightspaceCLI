package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPaths_CreateDirs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))

	layout := testSystemLayout(t, PathKindConfig, PathKindData)
	dir := layout.ConfigDir

	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("ensure config dir: %v", err)
	}

	if _, statErr := os.Stat(dir); statErr != nil {
		t.Fatalf("expected dir: %v", statErr)
	}

	if filepath.Base(dir) != AppName {
		t.Fatalf("unexpected base: %q", filepath.Base(dir))
	}

	keyringDir, err := layout.EnsureKeyringDir()
	if err != nil {
		t.Fatalf("EnsureKeyringDir: %v", err)
	}

	if _, statErr := os.Stat(keyringDir); statErr != nil {
		t.Fatalf("expected keyring dir: %v", statErr)
	}

	credsPath, err := layout.ClientCredentialsPathFor(DefaultClientName)
	if err != nil {
		t.Fatalf("ClientCredentialsPath: %v", err)
	}

	if filepath.Base(credsPath) != "credentials.json" {
		t.Fatalf("unexpected creds file: %q", filepath.Base(credsPath))
	}
}

func TestExpandPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{
			name:  "empty path",
			input: "",
			want:  "",
		},
		{
			name:  "tilde only",
			input: "~",
			want:  home,
		},
		{
			name:  "tilde with subpath",
			input: "~/Downloads/file.txt",
			want:  filepath.Join(home, "Downloads/file.txt"),
		},
		{
			name:  "tilde with backslash subpath",
			input: `~\Downloads\file.txt`,
			want:  filepath.Join(home, `Downloads\file.txt`),
		},
		{
			name:  "absolute path unchanged",
			input: "/usr/local/bin",
			want:  "/usr/local/bin",
		},
		{
			name:  "relative path unchanged",
			input: "relative/path/file.txt",
			want:  "relative/path/file.txt",
		},
		{
			name:  "tilde in middle unchanged",
			input: "/some/~/path",
			want:  "/some/~/path",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ExpandPath(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("ExpandPath() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if got != tt.want {
				t.Errorf("ExpandPath() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestKeepServiceAccountPath_SafeFilename(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))

	layout := testSystemLayout(t, PathKindData)
	dir := layout.DataDir
	p := layout.KeepServiceAccountPath("a/b@EXAMPLE.com")

	if filepath.Dir(p) != dir {
		t.Fatalf("expected keep path under %q, got %q", dir, p)
	}

	if strings.Contains(filepath.Base(p), "/") || strings.Contains(filepath.Base(p), "\\") {
		t.Fatalf("expected filename only, got %q", filepath.Base(p))
	}

	if !strings.HasPrefix(filepath.Base(p), "keep-sa-") || !strings.HasSuffix(filepath.Base(p), ".json") {
		t.Fatalf("unexpected keep filename: %q", filepath.Base(p))
	}
}
