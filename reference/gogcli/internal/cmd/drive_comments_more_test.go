package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

func TestDriveCommentsGetUpdateDeleteReply(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/drive/v3")
		switch {
		case r.Method == http.MethodGet && path == "/files/file1/comments":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"comments": []map[string]any{
					{
						"id":          "c-list",
						"content":     "list",
						"createdTime": "2025-01-01T00:00:00Z",
						"resolved":    false,
						"quotedFileContent": map[string]any{
							"value": "quoted",
						},
					},
				},
			})
			return
		case r.Method == http.MethodGet && path == "/files/file1/comments/c1":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "c1",
				"content":     "hello",
				"createdTime": "2025-01-01T00:00:00Z",
			})
			return
		case r.Method == http.MethodPatch && path == "/files/file1/comments/c1":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":           "c1",
				"content":      "updated",
				"modifiedTime": "2025-01-01T01:00:00Z",
			})
			return
		case r.Method == http.MethodPost && path == "/files/file1/comments":
			var body struct {
				Content           string `json:"content"`
				QuotedFileContent struct {
					Value string `json:"value"`
				} `json:"quotedFileContent"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Content == "" {
				http.Error(w, "missing content", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "c2",
				"content":     body.Content,
				"createdTime": "2025-01-01T03:00:00Z",
				"quotedFileContent": map[string]any{
					"value": body.QuotedFileContent.Value,
				},
			})
			return
		case r.Method == http.MethodDelete && path == "/files/file1/comments/c1":
			w.WriteHeader(http.StatusNoContent)
			return
		case r.Method == http.MethodPost && path == "/files/file1/comments/c1/replies":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "r1",
				"content":     "reply",
				"createdTime": "2025-01-01T02:00:00Z",
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

	getResult := executeWithDriveTestService(t, []string{"--json", "--account", "a@b.com", "drive", "comments", "get", "file1", "c1"}, svc)
	if getResult.err != nil {
		t.Fatalf("Execute get: %v", getResult.err)
	}
	if !strings.Contains(getResult.stdout, "\"content\":") {
		t.Fatalf("unexpected get output: %q", getResult.stdout)
	}

	plainGetResult := executeWithDriveTestService(t, []string{"--account", "a@b.com", "drive", "comments", "get", "file1", "c1"}, svc)
	if plainGetResult.err != nil {
		t.Fatalf("Execute get plain: %v", plainGetResult.err)
	}
	if !strings.Contains(plainGetResult.stdout, "content") {
		t.Fatalf("unexpected get plain output: %q", plainGetResult.stdout)
	}

	listResult := executeWithDriveTestService(t, []string{"--json", "--account", "a@b.com", "drive", "comments", "list", "file1"}, svc)
	if listResult.err != nil {
		t.Fatalf("Execute list: %v", listResult.err)
	}
	if !strings.Contains(listResult.stdout, "\"comments\"") {
		t.Fatalf("unexpected list output: %q", listResult.stdout)
	}

	plainListResult := executeWithDriveTestService(t, []string{"--account", "a@b.com", "drive", "comments", "list", "file1", "--include-quoted"}, svc)
	if plainListResult.err != nil {
		t.Fatalf("Execute list plain: %v", plainListResult.err)
	}
	if !strings.Contains(plainListResult.stdout, "quoted") {
		t.Fatalf("unexpected plain list output: %q", plainListResult.stdout)
	}

	createResult := executeWithDriveTestService(t, []string{"--json", "--account", "a@b.com", "drive", "comments", "create", "file1", "new comment", "--quoted", "quote"}, svc)
	if createResult.err != nil {
		t.Fatalf("Execute create: %v", createResult.err)
	}
	if !strings.Contains(createResult.stdout, "new comment") {
		t.Fatalf("unexpected create output: %q", createResult.stdout)
	}

	plainCreateResult := executeWithDriveTestService(t, []string{"--account", "a@b.com", "drive", "comments", "create", "file1", "plain comment"}, svc)
	if plainCreateResult.err != nil {
		t.Fatalf("Execute create plain: %v", plainCreateResult.err)
	}
	if !strings.Contains(plainCreateResult.stdout, "content") {
		t.Fatalf("unexpected create plain output: %q", plainCreateResult.stdout)
	}

	updateResult := executeWithDriveTestService(t, []string{"--json", "--account", "a@b.com", "drive", "comments", "update", "file1", "c1", "updated"}, svc)
	if updateResult.err != nil {
		t.Fatalf("Execute update: %v", updateResult.err)
	}
	if !strings.Contains(updateResult.stdout, "updated") {
		t.Fatalf("unexpected update output: %q", updateResult.stdout)
	}

	plainUpdateResult := executeWithDriveTestService(t, []string{"--account", "a@b.com", "drive", "comments", "update", "file1", "c1", "updated"}, svc)
	if plainUpdateResult.err != nil {
		t.Fatalf("Execute update plain: %v", plainUpdateResult.err)
	}
	if !strings.Contains(plainUpdateResult.stdout, "updated") {
		t.Fatalf("unexpected update plain output: %q", plainUpdateResult.stdout)
	}

	deleteResult := executeWithDriveTestService(t, []string{"--json", "--force", "--account", "a@b.com", "drive", "comments", "delete", "file1", "c1"}, svc)
	if deleteResult.err != nil {
		t.Fatalf("Execute delete: %v", deleteResult.err)
	}
	var deleted struct {
		Deleted   bool   `json:"deleted"`
		FileID    string `json:"fileId"`
		CommentID string `json:"commentId"`
	}
	if err := json.Unmarshal([]byte(deleteResult.stdout), &deleted); err != nil {
		t.Fatalf("delete json parse: %v", err)
	}
	if !deleted.Deleted || deleted.FileID != "file1" || deleted.CommentID != "c1" {
		t.Fatalf("unexpected delete output: %#v", deleted)
	}

	plainDeleteResult := executeWithDriveTestService(t, []string{"--force", "--account", "a@b.com", "drive", "comments", "delete", "file1", "c1"}, svc)
	if plainDeleteResult.err != nil {
		t.Fatalf("Execute delete plain: %v", plainDeleteResult.err)
	}
	if !strings.Contains(plainDeleteResult.stdout, "deleted") {
		t.Fatalf("unexpected delete plain output: %q", plainDeleteResult.stdout)
	}

	replyResult := executeWithDriveTestService(t, []string{"--json", "--account", "a@b.com", "drive", "comments", "reply", "file1", "c1", "reply"}, svc)
	if replyResult.err != nil {
		t.Fatalf("Execute reply: %v", replyResult.err)
	}
	if !strings.Contains(replyResult.stdout, "reply") {
		t.Fatalf("unexpected reply output: %q", replyResult.stdout)
	}

	plainReplyResult := executeWithDriveTestService(t, []string{"--account", "a@b.com", "drive", "comments", "reply", "file1", "c1", "reply"}, svc)
	if plainReplyResult.err != nil {
		t.Fatalf("Execute reply plain: %v", plainReplyResult.err)
	}
	if !strings.Contains(plainReplyResult.stdout, "reply") {
		t.Fatalf("unexpected reply plain output: %q", plainReplyResult.stdout)
	}
}
