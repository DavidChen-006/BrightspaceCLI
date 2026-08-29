package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExecute_GmailThreadAliases(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/gmail/v1")
		switch {
		case r.Method == http.MethodGet && path == "/users/me/threads/t1":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "t1",
				"messages": []map[string]any{
					{
						"id": "m1",
						"payload": map[string]any{
							"headers": []map[string]any{
								{"name": "From", "value": "me@example.com"},
								{"name": "To", "value": "you@example.com"},
								{"name": "Subject", "value": "Hello"},
								{"name": "Date", "value": "Wed, 21 Jan 2026 12:00:00 +0000"},
							},
						},
					},
				},
			})
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	svc := newGmailServiceFromServer(t, srv)
	cases := [][]string{
		{"--plain", "--account", "a@b.com", "gmail", "read", "t1"},
		{"--plain", "--account", "a@b.com", "gmail", "thread", "t1"},
	}
	for _, args := range cases {
		result := executeWithGmailTestService(t, args, svc)
		if result.err != nil {
			t.Fatalf("Execute %v: %v\nstderr=%q", args, result.err, result.stderr)
		}
		if !strings.Contains(result.stdout, "Thread contains 1 message(s)") {
			t.Fatalf("unexpected output for %v: %q", args, result.stdout)
		}
	}
}
