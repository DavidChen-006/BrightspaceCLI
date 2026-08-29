package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExecute_GmailLabelsGet_Text(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/gmail/v1/users/me/labels") && r.Method == http.MethodGet && !strings.Contains(r.URL.Path, "/labels/"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"labels": []map[string]any{
					{"id": "INBOX", "name": "INBOX", "type": "system"},
				},
			})
			return
		case strings.Contains(r.URL.Path, "/gmail/v1/users/me/labels/INBOX") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "INBOX",
				"name":           "INBOX",
				"type":           "system",
				"messagesTotal":  1,
				"messagesUnread": 2,
				"threadsTotal":   3,
				"threadsUnread":  4,
			})
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	result := executeWithGmailTestService(
		t,
		[]string{"--plain", "--account", "a@b.com", "gmail", "labels", "get", "INBOX"},
		newGmailServiceFromServer(t, srv),
	)
	if result.err != nil {
		t.Fatalf("Execute: %v\nstderr=%q", result.err, result.stderr)
	}
	if !strings.Contains(result.stdout, "id\tINBOX") || !strings.Contains(result.stdout, "messages_total\t1") || !strings.Contains(result.stdout, "threads_unread\t4") {
		t.Fatalf("unexpected out=%q", result.stdout)
	}
}
