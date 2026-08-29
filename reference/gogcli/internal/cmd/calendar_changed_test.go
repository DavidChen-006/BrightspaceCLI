package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestCalendarChanged_JSON(t *testing.T) {
	var showDeleted string
	svc, closeServer := newCalendarServiceForTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/calendars/primary/events") && r.Method == http.MethodGet {
			showDeleted = r.URL.Query().Get("showDeleted")
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]any{
					{
						"id":      "e1",
						"summary": "Older event",
						"updated": "2026-06-10T08:00:00Z",
						"start":   map[string]any{"dateTime": "2026-06-15T10:00:00Z"},
						"end":     map[string]any{"dateTime": "2026-06-15T11:00:00Z"},
					},
					{
						"id":      "e2",
						"summary": "Newer event",
						"updated": "2026-06-12T09:00:00Z",
						"start":   map[string]any{"dateTime": "2026-06-20T10:00:00Z"},
						"end":     map[string]any{"dateTime": "2026-06-20T11:00:00Z"},
					},
					{
						"id":      "e3",
						"summary": "Deleted event",
						"status":  "cancelled",
						"updated": "2026-06-13T09:00:00Z",
					},
				},
			})
			return
		}
		// Calendar timezone lookup
		if strings.Contains(r.URL.Path, "/calendars/primary") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "primary", "timeZone": "UTC"})
			return
		}
		http.NotFound(w, r)
	}))
	defer closeServer()

	var output bytes.Buffer
	ctx := newCmdRuntimeJSONOutputContext(t, &output, io.Discard)
	cmd := &CalendarChangedCmd{Max: 10, Since: "720h"}
	if err := cmd.listChangedSingle(ctx, svc, "primary", "2026-05-14T00:00:00Z"); err != nil {
		t.Fatalf("listChangedSingle: %v", err)
	}

	var parsed struct {
		Events []map[string]any `json:"events"`
		Since  string           `json:"since"`
	}
	if err := json.Unmarshal(output.Bytes(), &parsed); err != nil {
		t.Fatalf("json parse: %v", err)
	}
	if showDeleted != "true" {
		t.Fatalf("showDeleted = %q, want true", showDeleted)
	}
	if len(parsed.Events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(parsed.Events))
	}
	// Most recently updated event should come first (descending order).
	if parsed.Events[0]["id"] != "e3" {
		t.Errorf("expected deleted e3 first (more recent updated), got %v", parsed.Events[0]["id"])
	}
	if parsed.Events[1]["id"] != "e2" || parsed.Events[2]["id"] != "e1" {
		t.Errorf("expected remaining events in descending order, got %v then %v", parsed.Events[1]["id"], parsed.Events[2]["id"])
	}
	if parsed.Since == "" {
		t.Error("expected since field in JSON output")
	}
}

func TestCalendarChanged_Table(t *testing.T) {
	svc, closeServer := newCalendarServiceForTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/calendars/cal1/events") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]any{
					{
						"id":      "ev1",
						"summary": "Meeting",
						"updated": "2026-06-13T10:00:00Z",
						"start":   map[string]any{"dateTime": "2026-06-14T09:00:00Z"},
						"end":     map[string]any{"dateTime": "2026-06-14T10:00:00Z"},
					},
				},
			})
			return
		}
		if strings.Contains(r.URL.Path, "/calendars/cal1") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "cal1", "timeZone": "UTC"})
			return
		}
		http.NotFound(w, r)
	}))
	defer closeServer()

	var output bytes.Buffer
	ctx := newCmdRuntimeOutputContext(t, &output, io.Discard)
	cmd := &CalendarChangedCmd{Max: 10}
	if err := cmd.listChangedSingle(ctx, svc, "cal1", "2026-05-14T00:00:00Z"); err != nil {
		t.Fatalf("listChangedSingle: %v", err)
	}

	out := output.String()
	if !strings.Contains(out, "UPDATED") {
		t.Errorf("table output missing UPDATED column header; got:\n%s", out)
	}
	if !strings.Contains(out, "Meeting") {
		t.Errorf("table output missing event summary; got:\n%s", out)
	}
	if !strings.Contains(out, "ev1") {
		t.Errorf("table output missing event ID; got:\n%s", out)
	}
}

func TestCalendarChanged_MaxLimitsResults(t *testing.T) {
	svc, closeServer := newCalendarServiceForTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/calendars/primary/events") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]any{
					{"id": "e1", "summary": "A", "updated": "2026-06-10T01:00:00Z", "start": map[string]any{"dateTime": "2026-06-15T10:00:00Z"}, "end": map[string]any{"dateTime": "2026-06-15T11:00:00Z"}},
					{"id": "e2", "summary": "B", "updated": "2026-06-10T02:00:00Z", "start": map[string]any{"dateTime": "2026-06-15T10:00:00Z"}, "end": map[string]any{"dateTime": "2026-06-15T11:00:00Z"}},
					{"id": "e3", "summary": "C", "updated": "2026-06-10T03:00:00Z", "start": map[string]any{"dateTime": "2026-06-15T10:00:00Z"}, "end": map[string]any{"dateTime": "2026-06-15T11:00:00Z"}},
				},
			})
			return
		}
		if strings.Contains(r.URL.Path, "/calendars/primary") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "primary", "timeZone": "UTC"})
			return
		}
		http.NotFound(w, r)
	}))
	defer closeServer()

	var output bytes.Buffer
	ctx := newCmdRuntimeJSONOutputContext(t, &output, io.Discard)
	cmd := &CalendarChangedCmd{Max: 2}
	if err := cmd.listChangedSingle(ctx, svc, "primary", "2026-05-01T00:00:00Z"); err != nil {
		t.Fatalf("listChangedSingle: %v", err)
	}

	var parsed struct {
		Events []map[string]any `json:"events"`
	}
	if err := json.Unmarshal(output.Bytes(), &parsed); err != nil {
		t.Fatalf("json parse: %v", err)
	}
	if len(parsed.Events) != 2 {
		t.Fatalf("expected 2 events (max), got %d", len(parsed.Events))
	}
	// Should be the 2 most recently updated (e3, e2 in that order).
	if parsed.Events[0]["id"] != "e3" {
		t.Errorf("expected e3 first, got %v", parsed.Events[0]["id"])
	}
}

func TestCalendarChanged_DefaultSince(t *testing.T) {
	var capturedUpdatedMin string
	svc, closeServer := newCalendarServiceForTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/calendars/primary/events") {
			capturedUpdatedMin, _ = url.QueryUnescape(r.URL.Query().Get("updatedMin"))
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []map[string]any{}})
			return
		}
		if strings.Contains(r.URL.Path, "/calendars/primary") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "primary", "timeZone": "UTC"})
			return
		}
		http.NotFound(w, r)
	}))
	defer closeServer()

	before := time.Now()
	cmd := &CalendarChangedCmd{Max: 10}
	since, err := cmd.resolveSince()
	if err != nil {
		t.Fatalf("resolveSince: %v", err)
	}

	ctx := newCmdRuntimeJSONOutputContext(t, io.Discard, io.Discard)
	_ = cmd.listChangedSingle(ctx, svc, "primary", since.UTC().Format(time.RFC3339))

	if capturedUpdatedMin == "" {
		t.Fatal("updatedMin query param not sent to API")
	}
	parsed, err := time.Parse(time.RFC3339, capturedUpdatedMin)
	if err != nil {
		t.Fatalf("could not parse captured updatedMin %q: %v", capturedUpdatedMin, err)
	}

	// Default should be ~30 days ago. Allow 2s slack for RFC3339 second-truncation and test execution time.
	expectedCenter := before.Add(-30 * 24 * time.Hour).Truncate(time.Second)
	diff := parsed.Sub(expectedCenter)
	if diff < -2*time.Second || diff > 2*time.Second {
		t.Errorf("default since %v not within 2s of expected 30-day window center %v (diff %v)", parsed, expectedCenter, diff)
	}
}
