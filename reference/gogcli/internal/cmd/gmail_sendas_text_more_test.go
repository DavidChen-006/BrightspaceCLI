package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGmailSendAsCreateVerifyDeleteUpdate_Text(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/settings/sendAs") && !strings.HasSuffix(r.URL.Path, "/verify"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sendAsEmail":        "alias@example.com",
				"verificationStatus": "pending",
			})
			return
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/verify"):
			w.WriteHeader(http.StatusNoContent)
			return
		case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/settings/sendAs/alias@example.com"):
			w.WriteHeader(http.StatusNoContent)
			return
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/settings/sendAs/alias@example.com"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sendAsEmail": "alias@example.com",
				"displayName": "Old Name",
			})
			return
		case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/settings/sendAs/alias@example.com"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sendAsEmail": "alias@example.com",
				"displayName": "New Name",
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	svc := newGmailServiceFromServer(t, srv)
	createResult := executeWithGmailTestService(t, []string{
		"--plain", "--account", "a@b.com",
		"gmail", "sendas", "create", "alias@example.com", "--display-name", "Alias",
	}, svc)
	if createResult.err != nil {
		t.Fatalf("create: %v\nstderr=%q", createResult.err, createResult.stderr)
	}
	if !strings.Contains(createResult.stderr, "Verification email sent") {
		t.Fatalf("unexpected stderr: %q", createResult.stderr)
	}
	if !strings.Contains(createResult.stdout, "send_as_email\talias@example.com") || !strings.Contains(createResult.stdout, "verification_status\tpending") {
		t.Fatalf("unexpected create output: %q", createResult.stdout)
	}

	verifyResult := executeWithGmailTestService(t, []string{
		"--plain", "--account", "a@b.com",
		"gmail", "sendas", "verify", "alias@example.com",
	}, svc)
	if verifyResult.err != nil {
		t.Fatalf("verify: %v\nstderr=%q", verifyResult.err, verifyResult.stderr)
	}
	if !strings.Contains(verifyResult.stdout, "Verification email sent to alias@example.com") {
		t.Fatalf("unexpected verify output: %q", verifyResult.stdout)
	}

	updateResult := executeWithGmailTestService(t, []string{
		"--plain", "--account", "a@b.com",
		"gmail", "sendas", "update", "alias@example.com", "--display-name", "New Name",
	}, svc)
	if updateResult.err != nil {
		t.Fatalf("update: %v\nstderr=%q", updateResult.err, updateResult.stderr)
	}
	if !strings.Contains(updateResult.stdout, "Updated send-as alias: alias@example.com") {
		t.Fatalf("unexpected update output: %q", updateResult.stdout)
	}

	deleteResult := executeWithGmailTestService(t, []string{
		"--plain", "--force", "--account", "a@b.com",
		"gmail", "sendas", "delete", "alias@example.com",
	}, svc)
	if deleteResult.err != nil {
		t.Fatalf("delete: %v\nstderr=%q", deleteResult.err, deleteResult.stderr)
	}
	if !strings.Contains(deleteResult.stdout, "Deleted send-as alias: alias@example.com") {
		t.Fatalf("unexpected delete output: %q", deleteResult.stdout)
	}
}
