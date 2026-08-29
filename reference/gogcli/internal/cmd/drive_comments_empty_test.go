package cmd

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestDriveCommentsList_Empty(t *testing.T) {
	svc, closeSrv := newDriveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/drive/v3")
		if r.Method == http.MethodGet && path == "/files/empty/comments" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"comments": []any{},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer closeSrv()

	result := executeWithDriveTestService(t, []string{"--account", "a@b.com", "drive", "comments", "list", "empty"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	if !strings.Contains(result.stderr, "No comments") {
		t.Fatalf("unexpected stderr: %q", result.stderr)
	}
}
