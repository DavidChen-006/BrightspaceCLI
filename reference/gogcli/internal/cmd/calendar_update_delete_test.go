package cmd

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/option"
)

func TestCalendarUpdateAndDelete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/calendar/v3")
		switch {
		case strings.Contains(path, "/calendars/cal1@example.com/events/evt1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":       "evt1",
				"summary":  "Old",
				"start":    map[string]any{"dateTime": "2025-01-01T10:00:00Z"},
				"end":      map[string]any{"dateTime": "2025-01-01T11:00:00Z"},
				"htmlLink": "http://example.com/event",
			})
			return
		case strings.Contains(path, "/calendars/cal1@example.com/events/evt1") && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":       "evt1",
				"summary":  "Updated",
				"htmlLink": "http://example.com/event",
			})
			return
		case strings.Contains(path, "/calendars/cal1@example.com/events/evt1") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	svc, err := calendar.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	flags := &RootFlags{Account: "a@b.com", Force: true}
	ctx := withCalendarTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	jsonCtx, output := newCalendarTestJSONContext(t, svc)

	// update requires changes
	updateCmd := &CalendarUpdateCmd{}
	if err := runKong(t, updateCmd, []string{"cal1@example.com", "evt1"}, ctx, flags); err == nil {
		t.Fatalf("expected no updates error")
	}

	// update json
	updateCmd = &CalendarUpdateCmd{}
	if err := runKong(t, updateCmd, []string{"cal1@example.com", "evt1", "--summary", "Updated"}, jsonCtx, flags); err != nil {
		t.Fatalf("update: %v", err)
	}
	if !strings.Contains(output.String(), "Updated") {
		t.Fatalf("unexpected update json: %q", output.String())
	}

	// delete json
	output.Reset()
	deleteCmd := &CalendarDeleteCmd{}
	if err := runKong(t, deleteCmd, []string{"cal1@example.com", "evt1"}, jsonCtx, flags); err != nil {
		t.Fatalf("delete: %v", err)
	}
}
