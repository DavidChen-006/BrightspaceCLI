package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestGmailLabelsCreateCmd_NestedNameCreatesWhenAvailable(t *testing.T) {
	createCalled := false

	svc := newLabelsDeleteService(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && isLabelsListPath(r.URL.Path):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"labels": []map[string]any{
				{"id": "Label_flat", "name": "Other Label", "type": "user"},
			}})
			return
		case r.Method == http.MethodPost && isLabelsListPath(r.URL.Path):
			createCalled = true

			var body struct {
				Name string `json:"name"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if body.Name != "Projects/Review" {
				http.Error(w, "wrong label name", http.StatusBadRequest)
				return
			}

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":   "Label_nested",
				"name": body.Name,
				"type": "user",
			})
			return
		default:
			http.NotFound(w, r)
		}
	})

	flags := &RootFlags{Account: "a@b.com"}
	var out bytes.Buffer
	ctx := withGmailTestService(newCmdRuntimeJSONOutputContext(t, &out, io.Discard), svc)
	if err := runKong(t, &GmailLabelsCreateCmd{}, []string{"Projects/Review"}, ctx, flags); err != nil {
		t.Fatalf("execute: %v", err)
	}

	if !createCalled {
		t.Fatal("expected label create call")
	}

	var parsed struct {
		Label struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"label"`
	}
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out.String())
	}
	if parsed.Label.ID != "Label_nested" || parsed.Label.Name != "Projects/Review" {
		t.Fatalf("unexpected label: %#v", parsed.Label)
	}
}

func TestGmailLabelsCreateCmd_NestedNameConflictsWithHyphenatedSibling(t *testing.T) {
	createCalled := false

	svc := newLabelsDeleteService(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && isLabelsListPath(r.URL.Path):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"labels": []map[string]any{
				{"id": "Label_flat", "name": "gog-pr-review", "type": "user"},
			}})
			return
		case r.Method == http.MethodPost && isLabelsListPath(r.URL.Path):
			createCalled = true
			http.Error(w, "create should not be called", http.StatusInternalServerError)
			return
		default:
			http.NotFound(w, r)
		}
	})

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withGmailTestService(newCmdRuntimeJSONOutputContext(t, io.Discard, io.Discard), svc)

	err := runKong(t, &GmailLabelsCreateCmd{}, []string{"gog/pr-review"}, ctx, flags)
	if err == nil {
		t.Fatal("expected duplicate label error")
	}
	if !strings.Contains(err.Error(), "label already exists") {
		t.Fatalf("unexpected error: %v", err)
	}
	if createCalled {
		t.Fatal("create should not be called for Gmail slash/hyphen collision")
	}
}
