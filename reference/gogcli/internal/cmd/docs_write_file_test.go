package cmd

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDocsWriteUpdate_FileInput(t *testing.T) {
	docSvc, capture := newDocsBatchUpdateTestService(t, docsBodyWithEndIndex(12))

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withDocsTestService(newCmdRuntimeJSONOutputContext(t, io.Discard, io.Discard), docSvc)
	tmpDir := t.TempDir()

	tmpFile := filepath.Join(tmpDir, "test-input.txt")
	if err := os.WriteFile(tmpFile, []byte("file content"), 0o600); err != nil {
		t.Fatalf("write temp file: %v", err)
	}

	if err := runKong(t, &DocsWriteCmd{}, []string{"doc1", "--file", tmpFile}, ctx, flags); err != nil {
		t.Fatalf("write with file: %v", err)
	}
	if len(capture.Requests) != 1 {
		t.Fatalf("expected 1 batch request, got %d", len(capture.Requests))
	}
	if got := capture.Requests[0]; len(got) != 2 || got[0].DeleteContentRange == nil || got[1].InsertText == nil {
		t.Fatalf("unexpected write requests: %#v", got)
	}
	if got := capture.Requests[0][1].InsertText; got.Location.Index != 1 || got.Text != "file content" {
		t.Fatalf("unexpected insert from file: got Text=%q, want %q", got.Text, "file content")
	}

	updateFile := filepath.Join(tmpDir, "update-input.txt")
	if err := os.WriteFile(updateFile, []byte("updated text"), 0o600); err != nil {
		t.Fatalf("write update temp file: %v", err)
	}
	if err := runKong(t, &DocsUpdateCmd{}, []string{"doc1", "--file", updateFile}, ctx, flags); err != nil {
		t.Fatalf("update with file: %v", err)
	}
	if len(capture.Requests) != 2 {
		t.Fatalf("expected 2 batch requests, got %d", len(capture.Requests))
	}
	if got := capture.Requests[1]; len(got) != 1 || got[0].InsertText == nil {
		t.Fatalf("unexpected update requests: %#v", got)
	}
	if got := capture.Requests[1][0].InsertText; got.Location.Index != 11 || got.Text != "updated text" {
		t.Fatalf("unexpected update insert from file: got Text=%q at index %d, want %q at index 11",
			got.Text, got.Location.Index, "updated text")
	}

	appendFile := filepath.Join(tmpDir, "append-input.txt")
	if err := os.WriteFile(appendFile, []byte("appended"), 0o600); err != nil {
		t.Fatalf("write append temp file: %v", err)
	}
	if err := runKong(t, &DocsWriteCmd{}, []string{"doc1", "--file", appendFile, "--append"}, ctx, flags); err != nil {
		t.Fatalf("write append with file: %v", err)
	}
	if len(capture.Requests) != 3 {
		t.Fatalf("expected 3 batch requests, got %d", len(capture.Requests))
	}
	if got := capture.Requests[2]; len(got) != 1 || got[0].InsertText == nil {
		t.Fatalf("unexpected append requests: %#v", got)
	}
	if got := capture.Requests[2][0].InsertText; got.Location.Index != 11 || got.Text != "appended" {
		t.Fatalf("unexpected append insert from file: got Text=%q at index %d, want %q at index 11",
			got.Text, got.Location.Index, "appended")
	}

	indexFile := filepath.Join(tmpDir, "index-input.txt")
	if err := os.WriteFile(indexFile, []byte("at index 5"), 0o600); err != nil {
		t.Fatalf("write index temp file: %v", err)
	}
	if err := runKong(t, &DocsUpdateCmd{}, []string{"doc1", "--file", indexFile, "--index", "5"}, ctx, flags); err != nil {
		t.Fatalf("update with file and index: %v", err)
	}
	if len(capture.Requests) != 4 {
		t.Fatalf("expected 4 batch requests, got %d", len(capture.Requests))
	}
	if got := capture.Requests[3]; len(got) != 1 || got[0].InsertText == nil {
		t.Fatalf("unexpected update index requests: %#v", got)
	}
	if got := capture.Requests[3][0].InsertText; got.Location.Index != 5 || got.Text != "at index 5" {
		t.Fatalf("unexpected update index insert from file: got Text=%q at index %d, want %q at index 5",
			got.Text, got.Location.Index, "at index 5")
	}
}

func TestDocsWriteUpdate_FileInputErrors(t *testing.T) {
	docSvc, cleanup := newDocsServiceForTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer cleanup()

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withDocsTestService(newCmdRuntimeJSONOutputContext(t, io.Discard, io.Discard), docSvc)

	err := runKong(t, &DocsWriteCmd{}, []string{"doc1", "--file", "/nonexistent/path/file.txt"}, ctx, flags)
	if err == nil {
		t.Fatal("expected error for non-existent file, got nil")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected fs.ErrNotExist, got: %v", err)
	}

	tmpDir := t.TempDir()
	emptyFile := filepath.Join(tmpDir, "empty.txt")
	if writeErr := os.WriteFile(emptyFile, []byte(""), 0o600); writeErr != nil {
		t.Fatalf("write empty temp file: %v", writeErr)
	}
	err = runKong(t, &DocsWriteCmd{}, []string{"doc1", "--file", emptyFile}, ctx, flags)
	if err == nil {
		t.Fatal("expected error for empty file, got nil")
	}
	if !strings.Contains(err.Error(), "empty text") {
		t.Fatalf("expected 'empty text' error, got: %v", err)
	}

	testFile := filepath.Join(tmpDir, "test.txt")
	if writeErr := os.WriteFile(testFile, []byte("content"), 0o600); writeErr != nil {
		t.Fatalf("write test temp file: %v", writeErr)
	}
	err = runKong(t, &DocsWriteCmd{}, []string{"doc1", "--text", "hello", "--file", testFile}, ctx, flags)
	if err == nil {
		t.Fatal("expected error for both --text and --file, got nil")
	}
	if !strings.Contains(err.Error(), "use only one of --text or --file") {
		t.Fatalf("expected mutual exclusion error, got: %v", err)
	}

	err = runKong(t, &DocsWriteCmd{}, []string{"doc1", "--text", "hello", "--markdown"}, ctx, flags)
	if err == nil || !strings.Contains(err.Error(), "--markdown requires --replace or --append") {
		t.Fatalf("expected markdown mode error, got: %v", err)
	}

	err = runKong(t, &DocsWriteCmd{}, []string{"doc1", "--text", "hello", "--append", "--replace"}, ctx, flags)
	if err == nil || !strings.Contains(err.Error(), "--append cannot be combined with --replace") {
		t.Fatalf("expected append replace error, got: %v", err)
	}
}
