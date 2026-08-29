package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGmailDraftsCreateDelete_Text(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/gmail/v1/users/me/drafts") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "d1",
				"message": map[string]any{
					"id":       "m1",
					"threadId": "t1",
				},
			})
			return
		case strings.Contains(r.URL.Path, "/gmail/v1/users/me/drafts/d1") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	svc := newGmailServiceFromServer(t, srv)
	createResult := executeWithGmailTestService(t, []string{
		"--plain", "--account", "a@b.com",
		"gmail", "drafts", "create",
		"--to", "b@b.com",
		"--subject", "Hi",
		"--body", "Body",
	}, svc)
	if createResult.err != nil {
		t.Fatalf("create: %v\nstderr=%q", createResult.err, createResult.stderr)
	}
	deleteResult := executeWithGmailTestService(t, []string{
		"--plain", "--force", "--account", "a@b.com",
		"gmail", "drafts", "delete", "d1",
	}, svc)
	if deleteResult.err != nil {
		t.Fatalf("delete: %v\nstderr=%q", deleteResult.err, deleteResult.stderr)
	}
	combined := createResult.stdout + deleteResult.stdout
	if !strings.Contains(combined, "draft_id") || !strings.Contains(combined, "deleted") {
		t.Fatalf("unexpected output: %q", combined)
	}
}
