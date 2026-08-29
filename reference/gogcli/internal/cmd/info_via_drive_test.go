package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

func TestInfoViaDriveCmd_TextAndJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/files/") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":           "id1",
				"name":         "Test File",
				"mimeType":     "application/pdf",
				"size":         "123",
				"createdTime":  "2025-12-01T00:00:00Z",
				"modifiedTime": "2025-12-02T00:00:00Z",
				"webViewLink":  "https://example.com/id1",
				"parents":      []string{"p1", "p2"},
			})
			return
		}
		http.NotFound(w, r)
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

	flags := &RootFlags{Account: "a@b.com"}

	var outBuf bytes.Buffer
	ctx := withDriveTestService(newCmdRuntimeOutputContext(t, &outBuf, io.Discard), svc)

	if err := infoViaDrive(ctx, flags, infoViaDriveOptions{ArgName: "id"}, "id1"); err != nil {
		t.Fatalf("execute: %v", err)
	}
	text := outBuf.String()
	if !strings.Contains(text, "id\tid1") || !strings.Contains(text, "mime\tapplication/pdf") {
		t.Fatalf("unexpected text: %q", text)
	}

	var jsonOut bytes.Buffer
	ctx2 := withDriveTestService(newCmdRuntimeJSONOutputContext(t, &jsonOut, io.Discard), svc)
	if err := infoViaDrive(ctx2, flags, infoViaDriveOptions{ArgName: "id"}, "id1"); err != nil {
		t.Fatalf("execute: %v", err)
	}

	var parsed struct {
		File struct {
			ID       string   `json:"id"`
			Name     string   `json:"name"`
			MimeType string   `json:"mimeType"`
			Parents  []string `json:"parents"`
		} `json:"file"`
	}
	if err := json.Unmarshal(jsonOut.Bytes(), &parsed); err != nil {
		t.Fatalf("json parse: %v", err)
	}
	if parsed.File.ID != "id1" || parsed.File.MimeType != "application/pdf" || len(parsed.File.Parents) != 2 {
		t.Fatalf("unexpected json: %#v", parsed.File)
	}
}

func TestInfoViaDriveCmd_ExpectedMimeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/files/") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":       "id1",
				"name":     "Test File",
				"mimeType": "application/pdf",
			})
			return
		}
		http.NotFound(w, r)
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

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withDriveTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	if err := infoViaDrive(ctx, flags, infoViaDriveOptions{ArgName: "id", ExpectedMime: "application/vnd.google-apps.spreadsheet", KindLabel: "sheet"}, "id1"); err == nil || !strings.Contains(err.Error(), "not a sheet") {
		t.Fatalf("expected mime error, got: %v", err)
	}
}
