package cmd

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"google.golang.org/api/drive/v3"
)

func TestExecute_DriveDownload_WithOutStdout(t *testing.T) {
	t.Chdir(t.TempDir())

	svc, closeSvc := newDriveMetadataTestService(t, "text/plain")
	t.Cleanup(closeSvc)

	download := func(context.Context, *drive.Service, string) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Body:       io.NopCloser(strings.NewReader("abc")),
		}, nil
	}

	result := executeWithDriveTestOperations(t, []string{
		"--account", "a@b.com",
		"drive", "download", "id1",
		"--out", "-",
	}, svc, download, nil)
	if result.err != nil {
		t.Fatalf("Execute: %v\nstderr=%s", result.err, result.stderr)
	}

	if result.stdout != "abc" {
		t.Fatalf("stdout=%q, want raw bytes", result.stdout)
	}
	if _, statErr := os.Stat("-"); !os.IsNotExist(statErr) {
		t.Fatalf("expected no file named -, stat=%v", statErr)
	}
}

func TestExecute_DriveDownload_WithOutStdout_JSONRejected(t *testing.T) {
	svc, closeSvc := newDriveMetadataTestService(t, "text/plain")
	t.Cleanup(closeSvc)

	called := false
	download := func(context.Context, *drive.Service, string) (*http.Response, error) {
		called = true
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Body:       io.NopCloser(strings.NewReader("abc")),
		}, nil
	}

	result := executeWithDriveTestOperations(t, []string{
		"--json",
		"--account", "a@b.com",
		"drive", "download", "id1",
		"--out", "-",
	}, svc, download, nil)

	if result.err == nil || !strings.Contains(result.err.Error(), "can't combine --json with --out -") {
		t.Fatalf("unexpected error: %v", result.err)
	}
	if result.stdout != "" {
		t.Fatalf("stdout=%q, want empty", result.stdout)
	}
	if called {
		t.Fatalf("download should not be called")
	}
}

func TestExecute_DocsExport_WithOutStdout(t *testing.T) {
	t.Chdir(t.TempDir())

	svc, closeSvc := newDriveMetadataTestService(t, "application/vnd.google-apps.document")
	t.Cleanup(closeSvc)

	var gotExportMime string
	export := func(_ context.Context, _ *drive.Service, _ string, mimeType string) (*http.Response, error) {
		gotExportMime = mimeType
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Body:       io.NopCloser(strings.NewReader("plain text\n")),
		}, nil
	}

	result := executeWithDriveTestOperations(t, []string{
		"--account", "a@b.com",
		"docs", "export", "id1",
		"--out", "-",
		"--format", "txt",
	}, svc, nil, export)
	if result.err != nil {
		t.Fatalf("Execute: %v\nstderr=%s", result.err, result.stderr)
	}

	if result.stdout != "plain text\n" {
		t.Fatalf("stdout=%q, want raw export bytes", result.stdout)
	}
	if gotExportMime != "text/plain" {
		t.Fatalf("unexpected export mime type: %q", gotExportMime)
	}
	if _, statErr := os.Stat("-.txt"); !os.IsNotExist(statErr) {
		t.Fatalf("expected no file named -.txt, stat=%v", statErr)
	}
}

func TestExecute_DocsExport_WithOutStdout_JSONRejected(t *testing.T) {
	svc, closeSvc := newDriveMetadataTestService(t, "application/vnd.google-apps.document")
	t.Cleanup(closeSvc)

	called := false
	export := func(context.Context, *drive.Service, string, string) (*http.Response, error) {
		called = true
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Body:       io.NopCloser(strings.NewReader("plain text\n")),
		}, nil
	}

	result := executeWithDriveTestOperations(t, []string{
		"--json",
		"--account", "a@b.com",
		"docs", "export", "id1",
		"--out", "-",
		"--format", "txt",
	}, svc, nil, export)

	if result.err == nil || !strings.Contains(result.err.Error(), "can't combine --json with --out -") {
		t.Fatalf("unexpected error: %v", result.err)
	}
	if result.stdout != "" {
		t.Fatalf("stdout=%q, want empty", result.stdout)
	}
	if called {
		t.Fatalf("export should not be called")
	}
}
