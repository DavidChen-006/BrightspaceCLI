package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	formsapi "google.golang.org/api/forms/v1"
)

func TestFormsWatchCommands(t *testing.T) {
	var created formsapi.CreateWatchRequest
	deleteCalls := 0
	renewCalls := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/v1/forms/form1/watches") && !strings.Contains(r.URL.Path, ":"):
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Fatalf("decode create watch: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":         "watch1",
				"eventType":  "RESPONSES",
				"state":      "ACTIVE",
				"expireTime": "2026-03-15T00:00:00Z",
			})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/v1/forms/form1/watches"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"watches": []map[string]any{
					{"id": "watch1", "eventType": "RESPONSES", "state": "ACTIVE", "expireTime": "2026-03-15T00:00:00Z"},
				},
			})
		case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/v1/forms/form1/watches/watch1"):
			deleteCalls++
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/v1/forms/form1/watches/watch1:renew"):
			renewCalls++
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":         "watch1",
				"expireTime": "2026-03-22T00:00:00Z",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	svc := newFormsTestService(t, t.Context(), srv)
	ctx := withFormsTestService(newQuietUIContext(t), svc)
	flags := &RootFlags{Account: "a@b.com"}

	if err := runKong(t, &FormsWatchCreateCmd{}, []string{"form1", "--topic", "projects/p/topics/t1"}, ctx, flags); err != nil {
		t.Fatalf("create watch: %v", err)
	}
	if created.Watch == nil || created.Watch.Target == nil || created.Watch.Target.Topic == nil {
		t.Fatalf("unexpected create watch request: %#v", created)
	}
	if created.Watch.Target.Topic.TopicName != "projects/p/topics/t1" {
		t.Fatalf("unexpected topic: %#v", created.Watch.Target.Topic)
	}

	if err := runKong(t, &FormsWatchListCmd{}, []string{"form1"}, ctx, flags); err != nil {
		t.Fatalf("list watches: %v", err)
	}

	if err := runKong(t, &FormsWatchRenewCmd{}, []string{"form1", "watch1"}, ctx, flags); err != nil {
		t.Fatalf("renew watch: %v", err)
	}
	if renewCalls != 1 {
		t.Fatalf("expected one renew call, got %d", renewCalls)
	}

	if err := runKong(t, &FormsWatchDeleteCmd{}, []string{"form1", "watch1"}, ctx, flags); err != nil {
		t.Fatalf("delete watch: %v", err)
	}
	if deleteCalls != 1 {
		t.Fatalf("expected one delete call, got %d", deleteCalls)
	}
}

func TestFormsWatchCreateRejectsInvalidTopicBeforeDryRun(t *testing.T) {
	ctx := withFormsTestServiceFactory(newQuietUIContext(t), unexpectedFormsTestService(t, "forms service should not be created"))
	err := runKong(t, &FormsWatchCreateCmd{}, []string{"form1", "--topic", "nope"}, ctx, &RootFlags{Account: "a@b.com", DryRun: true})
	if err == nil {
		t.Fatal("expected topic validation error")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
	}
}

func TestFormsWatchList_JSONEmptyArray(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/v1/forms/form1/watches") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	svc := newFormsTestService(t, t.Context(), srv)
	var stdout bytes.Buffer
	ctx := withFormsTestService(newCmdRuntimeJSONOutputContext(t, &stdout, io.Discard), svc)
	flags := &RootFlags{Account: "a@b.com", JSON: true}
	if err := runKong(t, &FormsWatchListCmd{}, []string{"form1"}, ctx, flags); err != nil {
		t.Fatalf("list watches: %v", err)
	}
	out := stdout.String()

	var parsed struct {
		FormID  string            `json:"form_id"`
		Watches []*formsapi.Watch `json:"watches"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("unmarshal output: %v\n%s", err, out)
	}
	if parsed.FormID != "form1" {
		t.Fatalf("form_id = %q", parsed.FormID)
	}
	if parsed.Watches == nil {
		t.Fatalf("watches must be an empty array, got nil: %s", out)
	}
	if len(parsed.Watches) != 0 {
		t.Fatalf("watches len = %d, want 0", len(parsed.Watches))
	}
}
