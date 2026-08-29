package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/option"
)

func TestCalendarTimeCmd_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/calendars/primary" && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":       "primary",
				"summary":  "Primary Calendar",
				"timeZone": "America/Los_Angeles",
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
	result := executeWithCalendarTestService(t, []string{"--json", "--account", "a@b.com", "calendar", "time"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		Timezone    string `json:"timezone"`
		CurrentTime string `json:"current_time"`
		Formatted   string `json:"formatted"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out)
	}

	// Verify timezone
	if parsed.Timezone != "America/Los_Angeles" {
		t.Errorf("expected timezone America/Los_Angeles, got %q", parsed.Timezone)
	}

	// Verify current_time is valid RFC3339
	if _, err := time.Parse(time.RFC3339, parsed.CurrentTime); err != nil {
		t.Errorf("current_time is not valid RFC3339: %v", err)
	}

	// Verify formatted is not empty
	if parsed.Formatted == "" {
		t.Error("formatted time is empty")
	}
}

func TestCalendarTimeCmd_TableOutput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/calendars/primary" && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":       "primary",
				"summary":  "Primary Calendar",
				"timeZone": "America/New_York",
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
	result := executeWithCalendarTestService(t, []string{"--account", "a@b.com", "calendar", "time"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	// Verify table output contains expected fields
	if !strings.Contains(out, "timezone") {
		t.Errorf("output missing timezone field: %q", out)
	}
	if !strings.Contains(out, "current_time") {
		t.Errorf("output missing current_time field: %q", out)
	}
	if !strings.Contains(out, "formatted") {
		t.Errorf("output missing formatted field: %q", out)
	}
	if !strings.Contains(out, "America/New_York") {
		t.Errorf("output missing timezone value: %q", out)
	}
}

func TestCalendarTimeCmd_WithTimezoneFlag(t *testing.T) {
	result := executeWithCalendarTestServiceFactory(t, []string{"--json", "--account", "a@b.com", "calendar", "time", "--timezone", "UTC"}, func(context.Context, string) (*calendar.Service, error) {
		t.Fatal("should not call calendar service when --timezone is provided")
		return nil, errors.New("unexpected calendar service call")
	})
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		Timezone    string `json:"timezone"`
		CurrentTime string `json:"current_time"`
		Formatted   string `json:"formatted"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out)
	}

	// Verify timezone
	if parsed.Timezone != "UTC" {
		t.Errorf("expected timezone UTC, got %q", parsed.Timezone)
	}

	// Verify current_time is valid RFC3339 and ends with Z (UTC)
	parsedTime, err := time.Parse(time.RFC3339, parsed.CurrentTime)
	if err != nil {
		t.Errorf("current_time is not valid RFC3339: %v", err)
	}
	if parsedTime.Location().String() != "UTC" {
		t.Errorf("expected UTC timezone, got %q", parsedTime.Location().String())
	}
}

func TestCalendarTimeCmd_UsesEnvTimezone(t *testing.T) {
	envTZ := pickTimezoneExcluding(t)
	t.Setenv("GOG_TIMEZONE", envTZ)

	result := executeWithCalendarTestServiceFactory(t, []string{"--json", "--account", "a@b.com", "calendar", "time"}, func(context.Context, string) (*calendar.Service, error) {
		t.Fatal("should not call calendar service when GOG_TIMEZONE is provided")
		return nil, errors.New("unexpected calendar service call")
	})
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		Timezone    string `json:"timezone"`
		CurrentTime string `json:"current_time"`
		Formatted   string `json:"formatted"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out)
	}

	if parsed.Timezone != envTZ {
		t.Errorf("expected timezone %s, got %q", envTZ, parsed.Timezone)
	}
	if parsed.CurrentTime == "" || parsed.Formatted == "" {
		t.Errorf("expected current_time and formatted to be populated")
	}
}

func TestCalendarTimeCmd_WithTimezoneLocal(t *testing.T) {
	envTZ := pickNonLocalTimezone(t)
	t.Setenv("GOG_TIMEZONE", envTZ)

	result := executeWithCalendarTestServiceFactory(t, []string{"--json", "--account", "a@b.com", "calendar", "time", "--timezone", "local"}, func(context.Context, string) (*calendar.Service, error) {
		t.Fatal("should not call calendar service when --timezone local is provided")
		return nil, errors.New("unexpected calendar service call")
	})
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		Timezone string `json:"timezone"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out)
	}

	if parsed.Timezone != time.Local.String() {
		t.Errorf("expected timezone %q, got %q", time.Local.String(), parsed.Timezone)
	}
}

func TestCalendarTimeCmd_InvalidTimezone(t *testing.T) {
	result := executeWithCalendarTestServiceFactory(t, []string{"--account", "a@b.com", "calendar", "time", "--timezone", "Invalid/Timezone"}, func(context.Context, string) (*calendar.Service, error) {
		t.Fatal("should not call calendar service when invalid timezone is provided")
		return nil, errors.New("unexpected calendar service call")
	})
	if result.err == nil {
		t.Fatal("expected error for invalid timezone, got nil")
	}

	// Verify error message contains timezone information
	if !strings.Contains(result.stderr, "Invalid/Timezone") && !strings.Contains(result.stderr, "timezone") {
		t.Errorf("expected error message about invalid timezone, got: %q", result.stderr)
	}
}

func TestCalendarTimeCmd_CustomCalendar(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/calendars/custom-cal-id@example.com") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":       "custom-cal-id@example.com",
				"summary":  "Custom Calendar",
				"timeZone": "Europe/London",
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
	result := executeWithCalendarTestService(t, []string{"--json", "--account", "a@b.com", "calendar", "time", "--calendar", "custom-cal-id@example.com"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		Timezone    string `json:"timezone"`
		CurrentTime string `json:"current_time"`
		Formatted   string `json:"formatted"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out)
	}

	// Verify timezone from custom calendar
	if parsed.Timezone != "Europe/London" {
		t.Errorf("expected timezone Europe/London, got %q", parsed.Timezone)
	}
}
