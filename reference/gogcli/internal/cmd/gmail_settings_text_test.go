package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGmailSettings_TextPaths(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/gmail/v1/users/me/settings/delegates") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			if strings.Contains(path, "/delegates/") {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"delegateEmail":      "d@b.com",
					"verificationStatus": "accepted",
					"delegationEnabled":  true,
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"delegates": []map[string]any{
					{"delegateEmail": "d@b.com", "verificationStatus": "accepted"},
				},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/delegates") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"delegateEmail": "d@b.com", "verificationStatus": "pending"})
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/delegates/") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
			return

		case strings.Contains(path, "/gmail/v1/users/me/settings/forwardingAddresses") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			if strings.Contains(path, "/forwardingAddresses/") {
				_ = json.NewEncoder(w).Encode(map[string]any{"forwardingEmail": "f@b.com", "verificationStatus": "accepted"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"forwardingAddresses": []map[string]any{
					{"forwardingEmail": "f@b.com", "verificationStatus": "accepted"},
				},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/forwardingAddresses") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"forwardingEmail": "f@b.com", "verificationStatus": "pending"})
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/forwardingAddresses/") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
			return

		case strings.Contains(path, "/gmail/v1/users/me/settings/vacation") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"enableAutoReply":       false,
				"responseSubject":       "S",
				"responseBodyHtml":      "<b>hi</b>",
				"responseBodyPlainText": "hi",
				"startTime":             "111",
				"endTime":               "222",
				"restrictToContacts":    true,
				"restrictToDomain":      true,
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/vacation") && r.Method == http.MethodPut:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"enableAutoReply":    true,
				"responseSubject":    "S2",
				"startTime":          "123",
				"endTime":            "456",
				"restrictToContacts": true,
				"restrictToDomain":   false,
			})
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	svc := newGmailServiceFromServer(t, srv)
	commands := []struct {
		name string
		args []string
	}{
		{name: "delegates list", args: []string{"--plain", "--account", "a@b.com", "gmail", "delegates", "list"}},
		{name: "delegates get", args: []string{"--plain", "--account", "a@b.com", "gmail", "delegates", "get", "d@b.com"}},
		{name: "delegates add", args: []string{"--plain", "--force", "--account", "a@b.com", "gmail", "delegates", "add", "d@b.com"}},
		{name: "delegates remove", args: []string{"--plain", "--force", "--account", "a@b.com", "gmail", "delegates", "remove", "d@b.com"}},
		{name: "forwarding list", args: []string{"--plain", "--account", "a@b.com", "gmail", "forwarding", "list"}},
		{name: "forwarding get", args: []string{"--plain", "--account", "a@b.com", "gmail", "forwarding", "get", "f@b.com"}},
		{name: "forwarding create", args: []string{"--plain", "--account", "a@b.com", "gmail", "forwarding", "create", "f@b.com"}},
		{name: "forwarding delete", args: []string{"--plain", "--force", "--account", "a@b.com", "gmail", "forwarding", "delete", "f@b.com"}},
		{name: "vacation get", args: []string{"--plain", "--account", "a@b.com", "gmail", "vacation", "get"}},
		{name: "vacation update", args: []string{
			"--plain", "--account", "a@b.com", "gmail", "vacation", "update",
			"--enable",
			"--subject", "S2",
			"--body", "<b>hi</b>",
			"--start", "2025-01-01T00:00:00Z",
			"--end", "2025-01-02T00:00:00Z",
			"--contacts-only",
		}},
	}
	for _, command := range commands {
		result := executeWithGmailTestService(t, command.args, svc)
		if result.err != nil {
			t.Fatalf("%s: %v\nstderr=%q", command.name, result.err, result.stderr)
		}
	}
}

func TestGmailSettings_JSONEmptyListsUseArrays(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/gmail/v1/users/me/settings/forwardingAddresses"):
		case strings.Contains(r.URL.Path, "/gmail/v1/users/me/settings/delegates"):
		case strings.Contains(r.URL.Path, "/gmail/v1/users/me/settings/sendAs"):
		default:
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{})
	}))
	defer srv.Close()

	svc := newGmailServiceFromServer(t, srv)
	tests := []struct {
		name string
		args []string
		key  string
	}{
		{
			name: "forwarding",
			args: []string{"--json", "--account", "a@b.com", "gmail", "forwarding", "list"},
			key:  "forwardingAddresses",
		},
		{
			name: "delegates",
			args: []string{"--json", "--account", "a@b.com", "gmail", "delegates", "list"},
			key:  "delegates",
		},
		{
			name: "sendAs",
			args: []string{"--json", "--account", "a@b.com", "gmail", "sendas", "list"},
			key:  "sendAs",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := executeWithGmailTestService(t, tt.args, svc)
			if result.err != nil {
				t.Fatalf("run: %v\nstderr=%q", result.err, result.stderr)
			}
			var got map[string][]json.RawMessage
			if err := json.Unmarshal([]byte(result.stdout), &got); err != nil {
				t.Fatalf("json output %q: %v", result.stdout, err)
			}
			items, ok := got[tt.key]
			if !ok {
				t.Fatalf("missing key %q in %s", tt.key, result.stdout)
			}
			if items == nil {
				t.Fatalf("%s is nil in %s", tt.key, result.stdout)
			}
			if len(items) != 0 {
				t.Fatalf("%s len = %d in %s", tt.key, len(items), result.stdout)
			}
		})
	}
}

func TestGmailVacationUpdate_EnableDisableConflict(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com"}
	err := runKong(t, &GmailVacationUpdateCmd{}, []string{"--enable", "--disable"}, context.Background(), flags)
	if err == nil {
		t.Fatalf("expected conflict error")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
	}
}

func TestGmailVacationUpdate_InvalidTimesAreUsageErrors(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com", DryRun: true}
	for _, tt := range []struct {
		name string
		args []string
	}{
		{name: "start", args: []string{"--start", "nope"}},
		{name: "end", args: []string{"--end", "nope"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := runKong(t, &GmailVacationUpdateCmd{}, tt.args, context.Background(), flags)
			if err == nil {
				t.Fatal("expected error")
			}
			if got := ExitCode(err); got != 2 {
				t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
			}
		})
	}
}
