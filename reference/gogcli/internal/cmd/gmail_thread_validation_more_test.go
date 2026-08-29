package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/gmail/v1"
)

func TestGmailThreadGet_ValidationErrors(t *testing.T) {
	ctx := withGmailTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*gmail.Service, error) {
			t.Fatal("gmail service should not be created")
			return nil, context.Canceled
		},
	)

	if err := (&GmailThreadGetCmd{}).Run(ctx, &RootFlags{}); err == nil {
		t.Fatalf("expected missing account error")
	}
	if err := (&GmailThreadGetCmd{}).Run(ctx, &RootFlags{Account: "a@b.com"}); err == nil {
		t.Fatalf("expected missing threadId error")
	}
}

func TestGmailThreadModify_ValidationErrors(t *testing.T) {
	ctx := withGmailTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*gmail.Service, error) {
			t.Fatal("gmail service should not be created")
			return nil, context.Canceled
		},
	)
	flags := &RootFlags{Account: "a@b.com"}

	if err := (&GmailThreadModifyCmd{}).Run(ctx, flags); err == nil {
		t.Fatalf("expected missing threadId error")
	}
	if err := (&GmailThreadModifyCmd{ThreadID: "t1"}).Run(ctx, flags); err == nil {
		t.Fatalf("expected missing labels error")
	}
}

func TestGmailThreadAttachments_EmptyThread_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/gmail/v1/users/me/threads/t1") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":       "t1",
				"messages": []map[string]any{},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	var out bytes.Buffer
	ctx := withGmailTestService(
		newCmdRuntimeJSONOutputContext(t, &out, io.Discard),
		newGmailServiceFromServer(t, srv),
	)
	flags := &RootFlags{Account: "a@b.com"}

	if err := (&GmailThreadAttachmentsCmd{ThreadID: "t1"}).Run(ctx, flags); err != nil {
		t.Fatalf("attachments: %v", err)
	}
	if !strings.Contains(out.String(), "\"attachments\"") {
		t.Fatalf("unexpected output: %q", out.String())
	}
}
