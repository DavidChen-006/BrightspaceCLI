package cmd

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/gmail/v1"
)

func TestGmailSendCmd_ValidationErrors(t *testing.T) {
	ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)
	flags := &RootFlags{Account: "a@b.com"}

	cases := []GmailSendCmd{
		{ReplyToMessageID: "m1", ThreadID: "t1", To: "a@b.com", Subject: "S", Body: "B"},
		{ReplyAll: true, Subject: "S", Body: "B"},
		{Subject: "S", Body: "B"},
		{To: "a@b.com", Body: "B"},
		{To: "a@b.com", Subject: "S"},
		{To: "a@b.com", Subject: "S", Body: "B", TrackSplit: true},
		{To: "a@b.com", Subject: "S", Body: "B", Track: true},
	}

	for _, cmd := range cases {
		err := cmd.Run(ctx, flags)
		if err == nil {
			t.Fatalf("expected validation error")
		}
		if got := ExitCode(err); got != 2 {
			t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
		}
	}
}

func TestGmailSendCmd_InvalidHeadersAreUsageErrorsBeforeDryRun(t *testing.T) {
	ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)
	flags := &RootFlags{Account: "a@b.com", DryRun: true}

	for _, cmd := range []GmailSendCmd{
		{To: "bad\ncc:evil@example.com", Subject: "S", Body: "B"},
		{To: "a@example.com", ReplyTo: "bad\ncc:evil@example.com", Subject: "S", Body: "B"},
		{To: "a@example.com", Subject: "S\nInjected: yes", Body: "B"},
	} {
		err := cmd.Run(ctx, flags)
		if err == nil {
			t.Fatal("expected invalid header error")
		}
		if got := ExitCode(err); got != 2 {
			t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
		}
	}
}

func TestGmailSendCmd_MissingAccount(t *testing.T) {
	ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)
	cmd := &GmailSendCmd{To: "a@b.com", Subject: "S", Body: "B"}
	if err := cmd.Run(ctx, &RootFlags{}); err == nil {
		t.Fatalf("expected missing account error")
	}
}

func TestGmailSendCmd_ServiceError(t *testing.T) {
	ctx := withGmailTestServiceFactory(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), func(context.Context, string) (*gmail.Service, error) {
		return nil, errors.New("svc")
	})
	if err := (&GmailSendCmd{To: "a@b.com", Subject: "S", Body: "B"}).Run(ctx, &RootFlags{Account: "a@b.com"}); err == nil {
		t.Fatalf("expected service error")
	}
}

func TestGmailSendCmd_FromUnverified(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/gmail/v1/users/me/settings/sendAs/") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"sendAsEmail":"alias@example.com","verificationStatus":"pending"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	svc := newGmailServiceFromServer(t, srv)
	ctx := withGmailTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	cmd := &GmailSendCmd{To: "a@b.com", Subject: "S", Body: "B", From: "alias@example.com"}
	if err := cmd.Run(ctx, &RootFlags{Account: "a@b.com"}); err == nil {
		t.Fatalf("expected unverified from error")
	}
}

func TestGmailSendCmd_ReplyInfoError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	svc := newGmailServiceFromServer(t, srv)
	ctx := withGmailTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	cmd := &GmailSendCmd{
		To:               "a@b.com",
		Subject:          "S",
		Body:             "B",
		ReplyToMessageID: "m1",
	}
	if err := cmd.Run(ctx, &RootFlags{Account: "a@b.com"}); err == nil {
		t.Fatalf("expected reply info error")
	}
}
