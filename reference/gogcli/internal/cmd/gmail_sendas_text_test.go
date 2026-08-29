package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGmailSendAsListCmd_Text(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/settings/sendAs") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sendAs": []map[string]any{
					{
						"sendAsEmail":        "primary@example.com",
						"displayName":        "Primary",
						"isDefault":          true,
						"treatAsAlias":       false,
						"verificationStatus": "accepted",
					},
					{
						"sendAsEmail":        "alias@example.com",
						"displayName":        "Alias",
						"isDefault":          false,
						"treatAsAlias":       true,
						"verificationStatus": "pending",
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	result := executeWithGmailTestService(
		t,
		[]string{"--plain", "--account", "a@b.com", "gmail", "sendas", "list"},
		newGmailServiceFromServer(t, srv),
	)
	if result.err != nil {
		t.Fatalf("execute: %v\nstderr=%q", result.err, result.stderr)
	}

	if !strings.Contains(result.stdout, "EMAIL") || !strings.Contains(result.stdout, "primary@example.com") {
		t.Fatalf("unexpected output: %q", result.stdout)
	}
	if !strings.Contains(result.stdout, "alias@example.com") {
		t.Fatalf("missing alias line: %q", result.stdout)
	}
}

func TestGmailSendAsListCmd_TextEmpty(t *testing.T) {
	result := executeWithGmailTestService(
		t,
		[]string{"--plain", "--account", "a@b.com", "gmail", "sendas", "list"},
		newGmailEmptyListTestService(t, "/settings/sendAs", "sendAs"),
	)
	if result.err != nil {
		t.Fatalf("execute: %v\nstderr=%q", result.err, result.stderr)
	}

	if !strings.Contains(result.stderr, "No send-as aliases") {
		t.Fatalf("unexpected stderr: %q", result.stderr)
	}
}

func TestGmailSendAsGetCmd_Text(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/settings/sendAs/work@company.com") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sendAsEmail":        "work@company.com",
				"displayName":        "Work Alias",
				"replyToAddress":     "replies@company.com",
				"signature":          "Signature",
				"isDefault":          false,
				"isPrimary":          false,
				"treatAsAlias":       true,
				"verificationStatus": "accepted",
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	result := executeWithGmailTestService(
		t,
		[]string{"--plain", "--account", "a@b.com", "gmail", "sendas", "get", "work@company.com"},
		newGmailServiceFromServer(t, srv),
	)
	if result.err != nil {
		t.Fatalf("execute: %v\nstderr=%q", result.err, result.stderr)
	}

	if !strings.Contains(result.stdout, "send_as_email\twork@company.com") {
		t.Fatalf("unexpected output: %q", result.stdout)
	}
	if !strings.Contains(result.stdout, "verification_status\taccepted") {
		t.Fatalf("unexpected output: %q", result.stdout)
	}
}
