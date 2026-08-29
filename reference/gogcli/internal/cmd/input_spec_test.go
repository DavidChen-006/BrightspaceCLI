package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveInlineOrFileBytes_Literal(t *testing.T) {
	got, err := resolveInlineOrFileBytes(`{"a":1}`, strings.NewReader(""))
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if string(got) != `{"a":1}` {
		t.Fatalf("unexpected: %q", string(got))
	}
}

func TestResolveInlineOrFileBytes_File(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "in.json")
	if err := os.WriteFile(p, []byte(`{"ok":true}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := resolveInlineOrFileBytes("@"+p, strings.NewReader(""))
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if string(got) != `{"ok":true}` {
		t.Fatalf("unexpected: %q", string(got))
	}
}

func TestResolveInlineOrFileBytes_Stdin(t *testing.T) {
	got, err := resolveInlineOrFileBytes("-", strings.NewReader(`{"from":"stdin"}`))
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if string(got) != `{"from":"stdin"}` {
		t.Fatalf("unexpected: %q", string(got))
	}
}

func TestResolveInlineOrFileBytes_AtStdin(t *testing.T) {
	got, err := resolveInlineOrFileBytes("@-", strings.NewReader(`{"from":"@-"}`))
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if string(got) != `{"from":"@-"}` {
		t.Fatalf("unexpected: %q", string(got))
	}
}
