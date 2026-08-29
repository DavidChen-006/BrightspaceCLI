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

func TestGmailMessagesModifyCmd_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/users/me/labels"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"labels": []map[string]any{
					{"id": "INBOX", "name": "INBOX", "type": "system"},
					{"id": "TRASH", "name": "TRASH", "type": "system"},
					{"id": "Label_1", "name": "Custom", "type": "user"},
				},
			})
			return
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/users/me/messages/") && strings.HasSuffix(r.URL.Path, "/modify"):
			var body struct {
				AddLabelIds    []string `json:"addLabelIds"`
				RemoveLabelIds []string `json:"removeLabelIds"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.AddLabelIds) != 1 || body.AddLabelIds[0] != "Label_1" {
				http.Error(w, "bad addLabelIds", http.StatusBadRequest)
				return
			}
			if len(body.RemoveLabelIds) != 1 || body.RemoveLabelIds[0] != "INBOX" {
				http.Error(w, "bad removeLabelIds", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{})
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	svc := newGmailServiceFromServer(t, srv)
	flags := &RootFlags{Account: "a@b.com"}
	var out bytes.Buffer
	ctx := withGmailTestService(newCmdRuntimeJSONOutputContext(t, &out, io.Discard), svc)

	if err := runKong(t, &GmailMessagesModifyCmd{}, []string{
		"msg1",
		"--add", "Custom",
		"--remove", "INBOX",
	}, ctx, flags); err != nil {
		t.Fatalf("execute: %v", err)
	}

	var parsed struct {
		Modified      string   `json:"modified"`
		AddedLabels   []string `json:"addedLabels"`
		RemovedLabels []string `json:"removedLabels"`
	}
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out.String())
	}
	if parsed.Modified != "msg1" {
		t.Fatalf("unexpected modified: %q", parsed.Modified)
	}
	if len(parsed.AddedLabels) != 1 || parsed.AddedLabels[0] != "Label_1" {
		t.Fatalf("unexpected added labels: %#v", parsed.AddedLabels)
	}
	if len(parsed.RemovedLabels) != 1 || parsed.RemovedLabels[0] != "INBOX" {
		t.Fatalf("unexpected removed labels: %#v", parsed.RemovedLabels)
	}

	var plainOut bytes.Buffer
	plainCtx := withGmailTestService(newCmdRuntimeOutputContext(t, &plainOut, io.Discard), svc)
	if err := runKong(t, &GmailMessagesModifyCmd{}, []string{
		"msg1",
		"--add", "Custom",
		"--remove", "INBOX",
	}, plainCtx, flags); err != nil {
		t.Fatalf("execute plain: %v", err)
	}
	if !strings.Contains(plainOut.String(), "Modified message") {
		t.Fatalf("unexpected plain output: %q", plainOut.String())
	}
}

func TestGmailMessagesModifyCmd_ValidationErrors(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com"}
	ctx := withGmailTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*gmail.Service, error) {
			t.Fatal("gmail service should not be created")
			return nil, context.Canceled
		},
	)

	t.Run("no labels", func(t *testing.T) {
		err := runKong(t, &GmailMessagesModifyCmd{}, []string{"msg1"}, ctx, flags)
		if err == nil || !strings.Contains(err.Error(), "must specify --add and/or --remove") {
			t.Fatalf("expected validation error, got %v", err)
		}
	})

	t.Run("empty message id", func(t *testing.T) {
		err := runKong(t, &GmailMessagesModifyCmd{}, []string{"", "--add", "INBOX"}, ctx, flags)
		if err == nil || !strings.Contains(err.Error(), "empty messageId") {
			t.Fatalf("expected empty messageId error, got %v", err)
		}
	})
}
