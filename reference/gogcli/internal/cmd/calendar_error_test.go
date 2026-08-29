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

func TestCalendarCreateAndFreeBusy_Validation(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com"}

	createCmd := &CalendarCreateCmd{}
	if err := runKong(t, createCmd, []string{"cal1"}, context.Background(), flags); err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("expected required error, got %v", err)
	}

	freeBusyCmd := &CalendarFreeBusyCmd{}
	if err := runKong(t, freeBusyCmd, []string{"cal1"}, context.Background(), flags); err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("expected required error, got %v", err)
	}
}

func TestCalendarUpdate_AllDayRequiresFromTo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/calendar/v3")
		if strings.Contains(path, "/calendars/cal1/events/evt1") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":    "evt1",
				"start": map[string]any{"dateTime": "2025-01-01T10:00:00Z"},
				"end":   map[string]any{"dateTime": "2025-01-01T11:00:00Z"},
			})
			return
		}
		http.NotFound(w, r)
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

	flags := &RootFlags{Account: "a@b.com"}
	cmd := &CalendarUpdateCmd{}
	ctx := withCalendarTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	if err := runKong(t, cmd, []string{"cal1", "evt1", "--all-day"}, ctx, flags); err == nil || !strings.Contains(err.Error(), "when changing --all-day") {
		t.Fatalf("expected all-day error, got %v", err)
	}
}

func TestCalendarDelete_NoInput(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com", NoInput: true}
	cmd := &CalendarDeleteCmd{}
	ctx := withDefaultTestRuntime(context.Background())
	if err := runKong(t, cmd, []string{"cal1", "evt1"}, ctx, flags); err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("expected refusing error, got %v", err)
	}
}
