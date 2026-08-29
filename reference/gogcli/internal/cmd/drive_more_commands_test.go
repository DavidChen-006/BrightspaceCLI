package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

func TestDriveGetDownloadUploadURL_JSON(t *testing.T) {
	download := func(context.Context, *drive.Service, string) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader("filedata")),
		}, nil
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/drive/v3")
		switch {
		case strings.HasPrefix(path, "/files/") && r.Method == http.MethodGet:
			id := strings.TrimPrefix(path, "/files/")
			resp := map[string]any{
				"id":           id,
				"name":         "Report.pdf",
				"mimeType":     "application/pdf",
				"size":         "1234",
				"modifiedTime": "2025-12-01T12:00:00Z",
				"createdTime":  "2025-12-01T10:00:00Z",
				"description":  "desc",
				"starred":      true,
			}
			if id == "file1" {
				resp["webViewLink"] = "http://example.com/file1"
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
			return
		case strings.Contains(r.URL.Path, "/upload/drive/v3/files") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "up1",
				"name":        "Upload.txt",
				"mimeType":    "text/plain",
				"webViewLink": "http://example.com/upload",
			})
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	svc, err := drive.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	flags := &RootFlags{Account: "a@b.com", Force: true}
	var stdout bytes.Buffer
	ctx := withDriveTestOperations(newCmdRuntimeJSONOutputContext(t, &stdout, io.Discard), svc, download, nil)

	cmd := &DriveGetCmd{}
	if err := runKong(t, cmd, []string{"file1"}, ctx, flags); err != nil {
		t.Fatalf("get: %v", err)
	}

	outPath := filepath.Join(t.TempDir(), "download.bin")
	stdout.Reset()
	downloadCmd := &DriveDownloadCmd{}
	if err := runKong(t, downloadCmd, []string{"file1", "--out", outPath}, ctx, flags); err != nil {
		t.Fatalf("download: %v", err)
	}
	if st, statErr := os.Stat(outPath); statErr != nil || st.Size() == 0 {
		t.Fatalf("downloaded file missing: %v size=%d", statErr, st.Size())
	}

	local := filepath.Join(t.TempDir(), "upload.txt")
	if writeErr := os.WriteFile(local, []byte("data"), 0o600); writeErr != nil {
		t.Fatalf("write: %v", writeErr)
	}
	stdout.Reset()
	uploadCmd := &DriveUploadCmd{}
	if err := runKong(t, uploadCmd, []string{local, "--name", "Upload.txt"}, ctx, flags); err != nil {
		t.Fatalf("upload: %v", err)
	}

	stdout.Reset()
	urlCmd := &DriveURLCmd{}
	if err := runKong(t, urlCmd, []string{"file1", "file2"}, ctx, flags); err != nil {
		t.Fatalf("url: %v", err)
	}
	if urlOut := stdout.String(); !strings.Contains(urlOut, "file1") || !strings.Contains(urlOut, "drive.google.com") {
		t.Fatalf("unexpected url output: %q", urlOut)
	}
}
