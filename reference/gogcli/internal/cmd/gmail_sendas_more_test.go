package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGmailSendAs_VerifyDeleteUpdate_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/settings/sendAs/") && strings.HasSuffix(r.URL.Path, "/verify") && r.Method == http.MethodPost {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if strings.Contains(r.URL.Path, "/settings/sendAs/") && r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if strings.Contains(r.URL.Path, "/settings/sendAs/") && !strings.HasSuffix(r.URL.Path, "/verify") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sendAsEmail":        "work@company.com",
				"displayName":        "Work Alias",
				"replyToAddress":     "reply@company.com",
				"signature":          "Sig",
				"treatAsAlias":       true,
				"verificationStatus": "accepted",
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	svc := newGmailServiceFromServer(t, srv)

	verifyResult := executeWithGmailTestService(t, []string{
		"--json", "--account", "a@b.com",
		"gmail", "sendas", "verify", "work@company.com",
	}, svc)
	if verifyResult.err != nil {
		t.Fatalf("verify: %v\nstderr=%q", verifyResult.err, verifyResult.stderr)
	}

	updateResult := executeWithGmailTestService(t, []string{
		"--json", "--account", "a@b.com",
		"gmail", "sendas", "update", "work@company.com",
		"--display-name", "Work Alias",
		"--reply-to", "reply@company.com",
		"--signature", "Sig",
		"--treat-as-alias=true",
	}, svc)
	if updateResult.err != nil {
		t.Fatalf("update: %v\nstderr=%q", updateResult.err, updateResult.stderr)
	}

	deleteResult := executeWithGmailTestService(t, []string{
		"--json", "--force", "--account", "a@b.com",
		"gmail", "sendas", "delete", "work@company.com",
	}, svc)
	if deleteResult.err != nil {
		t.Fatalf("delete: %v\nstderr=%q", deleteResult.err, deleteResult.stderr)
	}
}
