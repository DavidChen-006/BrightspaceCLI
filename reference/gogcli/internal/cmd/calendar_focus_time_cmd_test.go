package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/option"
)

func TestCalendarFocusTimeCmd_JSON(t *testing.T) {
	srv := httptest.NewServer(withPrimaryCalendar(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/events") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "evt1",
				"summary": "Focus Time",
			})
			return
		}
		http.NotFound(w, r)
	})))
	defer srv.Close()

	svc, err := calendar.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	result := executeWithCalendarTestService(t, []string{"--json", "--account", "a@b.com", "calendar", "focus-time", "--from", "2025-01-01T10:00:00Z", "--to", "2025-01-01T11:00:00Z"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout
	if !strings.Contains(out, "event") {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestCalendarFocusTimeCmd_InvalidDateTimesAreUsageErrorsBeforeDryRun(t *testing.T) {
	factory := func(context.Context, string) (*calendar.Service, error) {
		t.Fatal("calendar service should not be created")
		return nil, context.Canceled
	}

	tests := []struct {
		name string
		from string
		to   string
	}{
		{name: "invalid from", from: "nope", to: "2025-01-01T10:00:00Z"},
		{name: "date only from", from: "2025-01-01", to: "2025-01-01T10:00:00Z"},
		{name: "date only to", from: "2025-01-01T09:00:00Z", to: "2025-01-01"},
		{name: "single digit hour", from: "2025-01-01T9:00:00Z", to: "2025-01-01T10:00:00Z"},
		{name: "comma fraction", from: "2025-01-01T09:00:00,123Z", to: "2025-01-01T10:00:00Z"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := withCalendarTestServiceFactory(newCmdRuntimeOutputContext(t, nil, nil), factory)
			err := (&CalendarFocusTimeCmd{From: tt.from, To: tt.to}).Run(ctx, &RootFlags{Account: "a@b.com", DryRun: true})
			if err == nil {
				t.Fatal("expected datetime validation error")
			}
			if got := ExitCode(err); got != 2 {
				t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
			}
		})
	}
}
