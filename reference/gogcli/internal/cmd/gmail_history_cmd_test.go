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

func TestGmailHistoryCmd_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/gmail/v1/users/me/history") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"history": []map[string]any{
				{
					"id":            "1",
					"messagesAdded": []map[string]any{{"message": map[string]any{"id": "m1"}}},
				},
			},
			"historyId":     "200",
			"nextPageToken": "npt",
		})
	}))
	defer srv.Close()

	flags := &RootFlags{Account: "a@b.com"}
	var out bytes.Buffer
	ctx := withGmailTestService(
		newCmdRuntimeJSONOutputContext(t, &out, io.Discard),
		newGmailServiceFromServer(t, srv),
	)
	cmd := &GmailHistoryCmd{}
	if err := runKong(t, cmd, []string{"--since", "100"}, ctx, flags); err != nil {
		t.Fatalf("execute: %v", err)
	}

	var parsed struct {
		HistoryID     string   `json:"historyId"`
		Messages      []string `json:"messages"`
		NextPageToken string   `json:"nextPageToken"`
	}
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("json parse: %v", err)
	}
	if parsed.HistoryID != "200" || len(parsed.Messages) != 1 || parsed.Messages[0] != "m1" {
		t.Fatalf("unexpected response: %#v", parsed)
	}
}

func TestGmailHistoryCmd_NoHistory(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/gmail/v1/users/me/history") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"history":   []map[string]any{},
			"historyId": "200",
		})
	}))
	defer srv.Close()

	flags := &RootFlags{Account: "a@b.com"}
	var errOut bytes.Buffer
	ctx := withGmailTestService(
		newCmdRuntimeOutputContext(t, io.Discard, &errOut),
		newGmailServiceFromServer(t, srv),
	)
	cmd := &GmailHistoryCmd{}
	if err := runKong(t, cmd, []string{"--since", "100"}, ctx, flags); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(errOut.String(), "No history") {
		t.Fatalf("expected no history message")
	}
}

func TestGmailHistoryCmd_InvalidSinceIsUsageError(t *testing.T) {
	ctx := withGmailTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*gmail.Service, error) {
			t.Fatal("gmail service should not be created")
			return nil, context.Canceled
		},
	)
	err := runKong(t, &GmailHistoryCmd{}, []string{"--since", "nope"}, ctx, &RootFlags{Account: "a@b.com"})
	if err == nil {
		t.Fatal("expected error")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
	}
	if !strings.Contains(err.Error(), `invalid historyId "nope"`) {
		t.Fatalf("unexpected error: %v", err)
	}
}
