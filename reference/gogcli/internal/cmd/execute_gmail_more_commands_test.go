package cmd

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecute_GmailThreadDraftsSend_JSON(t *testing.T) {
	// Keep attachments out of real config.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))
	wd := t.TempDir()
	origWD, _ := os.Getwd()
	t.Cleanup(func() { _ = os.Chdir(origWD) })
	if err := os.Chdir(wd); err != nil {
		t.Fatalf("chdir: %v", err)
	}

	attData := []byte("hello")
	attEncoded := base64.RawURLEncoding.EncodeToString(attData)
	bodyEncoded := base64.RawURLEncoding.EncodeToString([]byte("body"))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/gmail/v1/users/me/threads/t1"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "t1",
				"messages": []map[string]any{
					{
						"id":       "m1",
						"threadId": "t1",
						"labelIds": []string{"INBOX"},
						"payload": map[string]any{
							"headers": []map[string]any{
								{"name": "From", "value": "Me <me@example.com>"},
								{"name": "To", "value": "You <you@example.com>"},
								{"name": "Subject", "value": "Hello"},
								{"name": "Date", "value": "Wed, 17 Dec 2025 14:00:00 -0800"},
							},
							"parts": []map[string]any{
								{ // body
									"mimeType": "text/plain",
									"body":     map[string]any{"data": bodyEncoded},
								},
								{ // attachment
									"filename": "a.txt",
									"mimeType": "text/plain",
									"body":     map[string]any{"attachmentId": "a1", "size": len(attData)},
								},
							},
						},
					},
				},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/messages/m1/attachments/a1"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"data": attEncoded})
			return
		case strings.HasSuffix(path, "/gmail/v1/users/me/drafts") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"drafts":        []map[string]any{{"id": "d1", "message": map[string]any{"id": "m1", "threadId": "t1"}}},
				"nextPageToken": "npt",
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/drafts/d1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "d1",
				"message": map[string]any{
					"id":       "m1",
					"threadId": "t1",
					"payload": map[string]any{
						"parts": []map[string]any{
							{
								"filename": "a.txt",
								"mimeType": "text/plain",
								"body":     map[string]any{"attachmentId": "a1", "size": len(attData)},
							},
						},
					},
				},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/threads/t1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "t1",
				"messages": []map[string]any{
					{
						"id":       "m1",
						"threadId": "t1",
						"payload": map[string]any{
							"headers": []map[string]any{
								{"name": "Message-ID", "value": "<m1@example.com>"},
							},
						},
					},
				},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/drafts/d1") && r.Method == http.MethodPut:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "d1",
				"message": map[string]any{"id": "m1", "threadId": "t1"},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/drafts/d1") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
			return
		case strings.Contains(path, "/gmail/v1/users/me/drafts/send") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "m2", "threadId": "t2"})
			return
		case strings.Contains(path, "/gmail/v1/users/me/drafts") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "d2",
				"message": map[string]any{"id": "m3"},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/messages/send") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "m4", "threadId": "t4"})
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	svc := newGmailServiceFromServer(t, srv)
	run := func(args ...string) executeTestResult {
		return executeWithGmailTestService(t, args, svc)
	}

	result := run("--json", "--account", "a@b.com", "gmail", "thread", "get", "t1", "--download")
	if result.err != nil {
		t.Fatalf("thread: %v", result.err)
	}
	if !strings.Contains(result.stdout, "\"thread\"") || !strings.Contains(result.stdout, "\"downloaded\"") {
		t.Fatalf("unexpected out=%q", result.stdout)
	}

	// Verify attachment written to current directory (default).
	expectedPath := filepath.Join(wd, "m1_a1_a.txt")
	b, err := os.ReadFile(expectedPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(b) != string(attData) {
		t.Fatalf("content=%q", string(b))
	}

	commands := []struct {
		name string
		args []string
	}{
		{"drafts list", []string{"--json", "--account", "a@b.com", "gmail", "drafts", "list"}},
		{"drafts get", []string{"--json", "--account", "a@b.com", "gmail", "drafts", "get", "d1", "--download"}},
		{"drafts create", []string{"--json", "--account", "a@b.com", "gmail", "drafts", "create", "--to", "x@y.com", "--subject", "S", "--body", "B"}},
		{"drafts update", []string{"--json", "--account", "a@b.com", "gmail", "drafts", "update", "d1", "--to", "x@y.com", "--subject", "Updated", "--body", "B"}},
		{"drafts send", []string{"--json", "--account", "a@b.com", "gmail", "drafts", "send", "d1"}},
		{"drafts delete", []string{"--json", "--force", "--account", "a@b.com", "gmail", "drafts", "delete", "d1"}},
		{"send", []string{"--json", "--account", "a@b.com", "gmail", "send", "--to", "x@y.com", "--subject", "S", "--body", "B"}},
	}
	for _, command := range commands {
		if result := run(command.args...); result.err != nil {
			t.Fatalf("%s: %v", command.name, result.err)
		}
	}
}
