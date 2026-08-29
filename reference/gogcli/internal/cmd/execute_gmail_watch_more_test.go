package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecute_GmailWatch_MoreCommands(t *testing.T) {
	setWatchTestConfigHome(t)
	t.Setenv("GOG_ACCOUNT", "a@b.com")

	var stopCalled bool
	var watchCalls int

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/gmail/v1/users/me/labels") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"labels": []map[string]any{
					{"id": "INBOX", "name": "INBOX"},
					{"id": "Label_1", "name": "Custom"},
				},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/watch") && r.Method == http.MethodPost:
			watchCalls++
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"historyId":  "123",
				"expiration": "1730000000000",
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/stop") && r.Method == http.MethodPost:
			stopCalled = true
			w.WriteHeader(http.StatusNoContent)
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

	if result := run("--json", "gmail", "watch", "start", "--topic", "projects/p/topics/t", "--label", "INBOX"); result.err != nil {
		t.Fatalf("start: %v", result.err)
	}
	if watchCalls != 1 {
		t.Fatalf("expected watch call, got %d", watchCalls)
	}

	if result := run("--json", "gmail", "watch", "status"); result.err != nil {
		t.Fatalf("status: %v", result.err)
	}
	if result := run("--json", "gmail", "watch", "renew", "--ttl", "10"); result.err != nil {
		t.Fatalf("renew: %v", result.err)
	}
	if watchCalls != 2 {
		t.Fatalf("expected second watch call, got %d", watchCalls)
	}

	// Serve validations should fail before ListenAndServe.
	if result := run("gmail", "watch", "serve", "--path", "nope"); result.err == nil || !strings.Contains(result.err.Error(), "--path must start") {
		t.Fatalf("expected path validation error, got: %v", result.err)
	}
	if result := run("gmail", "watch", "serve", "--port", "0"); result.err == nil || !strings.Contains(result.err.Error(), "--port must be > 0") {
		t.Fatalf("expected port validation error, got: %v", result.err)
	}
	if result := run("gmail", "watch", "serve", "--bind", "0.0.0.0", "--path", "/x"); result.err == nil || !strings.Contains(result.err.Error(), "--verify-oidc or --token required") {
		t.Fatalf("expected bind validation error, got: %v", result.err)
	}

	if result := run("--json", "--force", "gmail", "watch", "stop"); result.err != nil {
		t.Fatalf("stop: %v", result.err)
	}

	if !stopCalled {
		t.Fatalf("expected stop called")
	}
	// State file removed.
	p, err := gmailWatchStatePath(gmailWatchTestLayout(t), "a@b.com")
	if err != nil {
		t.Fatalf("state path: %v", err)
	}
	if _, err := os.Stat(p); err == nil {
		t.Fatalf("expected watch state removed: %s", p)
	}

	// Ensure the account-scoped file is under the watch state directory shape.
	newWatchDir := filepath.Join("gogcli", "gmail-watch")
	legacyWatchDir := filepath.Join("gogcli", "state", "gmail-watch")
	if !strings.Contains(p, newWatchDir) && !strings.Contains(p, legacyWatchDir) {
		t.Fatalf("unexpected state path: %s", p)
	}
}
