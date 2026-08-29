package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExecute_GmailSettingsMoreCommands_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/gmail/v1/users/me/labels") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"labels": []map[string]any{
					{"id": "INBOX", "name": "INBOX"},
					{"id": "Label_1", "name": "Custom"},
					{"id": "SPAM", "name": "SPAM"},
					{"id": "IMPORTANT", "name": "IMPORTANT"},
				},
			})
			return

		// Delegates
		case strings.Contains(path, "/gmail/v1/users/me/settings/delegates") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			if strings.Contains(path, "/delegates/") {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"delegateEmail":       "d@b.com",
					"verificationStatus":  "accepted",
					"delegationEnabled":   true,
					"verificationStatus2": "ignored",
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

		// Forwarding addresses
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

		// Auto-forwarding
		case strings.Contains(path, "/gmail/v1/users/me/settings/autoForwarding") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"enabled":      false,
				"emailAddress": "f@b.com",
				"disposition":  "leaveInInbox",
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/autoForwarding") && r.Method == http.MethodPut:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"enabled":      true,
				"emailAddress": "f@b.com",
				"disposition":  "archive",
			})
			return

		// Vacation settings
		case strings.Contains(path, "/gmail/v1/users/me/settings/vacation") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"enableAutoReply":       false,
				"responseSubject":       "S",
				"responseBodyHtml":      "<b>hi</b>",
				"responseBodyPlainText": "hi",
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/vacation") && r.Method == http.MethodPut:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"enableAutoReply": true,
				"responseSubject": "S2",
			})
			return

		// Filters
		case strings.Contains(path, "/gmail/v1/users/me/settings/filters") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			if strings.Contains(path, "/filters/") {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"id": "f1",
					"criteria": map[string]any{
						"from": "a@example.com",
					},
					"action": map[string]any{
						"addLabelIds": []string{"Label_1"},
					},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"filter": []map[string]any{
					{"id": "f1", "criteria": map[string]any{"from": "a@example.com"}, "action": map[string]any{"addLabelIds": []string{"Label_1"}}},
				},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/filters") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "f2",
				"criteria": map[string]any{
					"from": "a@example.com",
				},
				"action": map[string]any{
					"addLabelIds": []string{"Label_1"},
				},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/filters/") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
			return

		// Send-as
		case strings.Contains(path, "/gmail/v1/users/me/settings/sendAs") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			if strings.Contains(path, "/sendAs/") {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"sendAsEmail":        "alias@b.com",
					"displayName":        "Alias",
					"replyToAddress":     "r@b.com",
					"signature":          "<b>sig</b>",
					"isPrimary":          false,
					"isDefault":          false,
					"treatAsAlias":       true,
					"verificationStatus": "accepted",
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sendAs": []map[string]any{
					{"sendAsEmail": "alias@b.com", "displayName": "Alias", "verificationStatus": "accepted", "isDefault": true},
				},
			})
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/sendAs") && r.Method == http.MethodPost && !strings.Contains(path, "/verify"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"sendAsEmail": "alias@b.com", "verificationStatus": "pending"})
			return
		case strings.Contains(path, "/verify") && r.Method == http.MethodPost:
			w.WriteHeader(http.StatusNoContent)
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/sendAs/") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
			return
		case strings.Contains(path, "/gmail/v1/users/me/settings/sendAs/") && r.Method == http.MethodPut:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"sendAsEmail": "alias@b.com", "verificationStatus": "accepted"})
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
		{name: "delegates list", args: []string{"--json", "--account", "a@b.com", "gmail", "delegates", "list"}},
		{name: "delegates get", args: []string{"--json", "--account", "a@b.com", "gmail", "delegates", "get", "d@b.com"}},
		{name: "delegates add", args: []string{"--json", "--force", "--account", "a@b.com", "gmail", "delegates", "add", "d@b.com"}},
		{name: "delegates remove", args: []string{"--json", "--force", "--account", "a@b.com", "gmail", "delegates", "remove", "d@b.com"}},
		{name: "forwarding list", args: []string{"--json", "--account", "a@b.com", "gmail", "forwarding", "list"}},
		{name: "forwarding get", args: []string{"--json", "--account", "a@b.com", "gmail", "forwarding", "get", "f@b.com"}},
		{name: "forwarding create", args: []string{"--json", "--account", "a@b.com", "gmail", "forwarding", "create", "f@b.com"}},
		{name: "forwarding delete", args: []string{"--json", "--force", "--account", "a@b.com", "gmail", "forwarding", "delete", "f@b.com"}},
		{name: "autoforward get", args: []string{"--json", "--account", "a@b.com", "gmail", "autoforward", "get"}},
		{name: "autoforward update", args: []string{"--json", "--account", "a@b.com", "gmail", "autoforward", "update", "--enable", "--email", "f@b.com", "--disposition", "archive"}},
		{name: "vacation get", args: []string{"--json", "--account", "a@b.com", "gmail", "vacation", "get"}},
		{name: "vacation update", args: []string{"--json", "--account", "a@b.com", "gmail", "vacation", "update", "--enable", "--subject", "S2", "--body", "<b>hi</b>"}},
		{name: "filters list", args: []string{"--json", "--account", "a@b.com", "gmail", "filters", "list"}},
		{name: "filters get", args: []string{"--json", "--account", "a@b.com", "gmail", "filters", "get", "f1"}},
		{name: "filters create", args: []string{"--json", "--account", "a@b.com", "gmail", "filters", "create", "--from", "a@example.com", "--add-label", "Custom"}},
		{name: "filters delete", args: []string{"--json", "--force", "--account", "a@b.com", "gmail", "filters", "delete", "f1"}},
		{name: "sendas list", args: []string{"--json", "--account", "a@b.com", "gmail", "sendas", "list"}},
		{name: "sendas get", args: []string{"--json", "--account", "a@b.com", "gmail", "sendas", "get", "alias@b.com"}},
		{name: "sendas create", args: []string{"--json", "--account", "a@b.com", "gmail", "sendas", "create", "alias@b.com", "--display-name", "Alias"}},
		{name: "sendas verify", args: []string{"--json", "--account", "a@b.com", "gmail", "sendas", "verify", "alias@b.com"}},
		{name: "sendas update", args: []string{"--json", "--account", "a@b.com", "gmail", "sendas", "update", "alias@b.com", "--make-default"}},
		{name: "sendas delete", args: []string{"--json", "--force", "--account", "a@b.com", "gmail", "sendas", "delete", "alias@b.com"}},
	}
	for _, command := range commands {
		result := executeWithGmailTestService(t, command.args, svc)
		if result.err != nil {
			t.Fatalf("%s: %v\nstderr=%q", command.name, result.err, result.stderr)
		}
	}
}
