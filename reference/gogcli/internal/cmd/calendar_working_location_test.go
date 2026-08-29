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

	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/option"
)

func TestWorkingLocationProperties(t *testing.T) {
	cmd := &CalendarWorkingLocationCmd{Type: "home"}
	props, err := cmd.buildWorkingLocationProperties()
	if err != nil {
		t.Fatalf("buildWorkingLocationProperties: %v", err)
	}
	if props.Type != "homeOffice" {
		t.Fatalf("unexpected type: %q", props.Type)
	}

	cmd = &CalendarWorkingLocationCmd{Type: "office", OfficeLabel: "HQ", BuildingId: "b1", FloorId: "f1", DeskId: "d1"}
	props, err = cmd.buildWorkingLocationProperties()
	if err != nil {
		t.Fatalf("buildWorkingLocationProperties office: %v", err)
	}
	if props.OfficeLocation == nil || props.OfficeLocation.Label != "HQ" {
		t.Fatalf("unexpected office props: %#v", props)
	}

	cmd = &CalendarWorkingLocationCmd{Type: "custom", CustomLabel: "Cafe"}
	props, err = cmd.buildWorkingLocationProperties()
	if err != nil {
		t.Fatalf("buildWorkingLocationProperties custom: %v", err)
	}
	if props.CustomLocation == nil || props.CustomLocation.Label != "Cafe" {
		t.Fatalf("unexpected custom props: %#v", props)
	}

	cmd = &CalendarWorkingLocationCmd{Type: "custom"}
	if _, err = cmd.buildWorkingLocationProperties(); err == nil {
		t.Fatalf("expected error for missing custom label")
	} else if got := ExitCode(err); got != 2 {
		t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
	}
}

func TestWorkingLocationSummary(t *testing.T) {
	cmd := &CalendarWorkingLocationCmd{Type: "home"}
	if cmd.generateSummary() != "Working from home" {
		t.Fatalf("unexpected home summary")
	}
	cmd = &CalendarWorkingLocationCmd{Type: "office", OfficeLabel: "HQ"}
	if cmd.generateSummary() != "Working from HQ" {
		t.Fatalf("unexpected office summary")
	}
	cmd = &CalendarWorkingLocationCmd{Type: "custom", CustomLabel: "Cafe"}
	if cmd.generateSummary() != "Working from Cafe" {
		t.Fatalf("unexpected custom summary")
	}
}

func TestCalendarWorkingLocation_RunJSON(t *testing.T) {
	var gotEvent calendar.Event
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/calendar/v3")
		if r.Method == http.MethodPost && path == "/calendars/cal@example.com/events" {
			if err := json.NewDecoder(r.Body).Decode(&gotEvent); err != nil {
				t.Fatalf("decode event: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "ev1",
				"summary": "Working from HQ",
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

	var output bytes.Buffer
	ctx := withCalendarTestService(newCmdRuntimeJSONOutputContext(t, &output, io.Discard), svc)
	cmd := &CalendarWorkingLocationCmd{}
	if err := runKong(t, cmd, []string{
		"cal@example.com",
		"--from", "2025-01-01",
		"--to", "2025-01-02",
		"--type", "office",
		"--office-label", "HQ",
		"--building-id", "b1",
		"--floor-id", "f1",
		"--desk-id", "d1",
	}, ctx, &RootFlags{Account: "a@b.com"}); err != nil {
		t.Fatalf("runKong: %v", err)
	}
	out := output.String()
	if !strings.Contains(out, "\"event\"") {
		t.Fatalf("unexpected output: %q", out)
	}

	if gotEvent.EventType != "workingLocation" {
		t.Fatalf("unexpected event type: %q", gotEvent.EventType)
	}
	if gotEvent.Transparency != transparencyTransparent {
		t.Fatalf("unexpected transparency: %q", gotEvent.Transparency)
	}
	if gotEvent.Visibility != "public" {
		t.Fatalf("unexpected visibility: %q", gotEvent.Visibility)
	}
	if gotEvent.Summary != "Working from HQ" {
		t.Fatalf("unexpected summary: %q", gotEvent.Summary)
	}
	props := gotEvent.WorkingLocationProperties
	if props == nil || props.Type != "officeLocation" || props.OfficeLocation == nil {
		t.Fatalf("unexpected working location props: %#v", props)
	}
	if props.OfficeLocation.Label != "HQ" || props.OfficeLocation.BuildingId != "b1" || props.OfficeLocation.FloorId != "f1" || props.OfficeLocation.DeskId != "d1" {
		t.Fatalf("unexpected office props: %#v", props.OfficeLocation)
	}
}

func TestCalendarWorkingLocation_InvalidFlagsAreUsageErrors(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{
			name: "custom missing label",
			args: []string{"--json", "calendar", "working-location", "primary", "--from", "2026-06-15", "--to", "2026-06-15", "--type", "custom", "--dry-run"},
		},
		{
			name: "invalid type",
			args: []string{"--json", "calendar", "working-location", "primary", "--from", "2026-06-15", "--to", "2026-06-15", "--type", "mars", "--dry-run"},
		},
		{
			name: "invalid from date",
			args: []string{"--json", "calendar", "working-location", "primary", "--from", "nope", "--to", "2026-06-15", "--type", "home", "--dry-run"},
		},
		{
			name: "datetime from date",
			args: []string{"--json", "calendar", "working-location", "primary", "--from", "2026-06-15T09:00:00Z", "--to", "2026-06-15", "--type", "home", "--dry-run"},
		},
		{
			name: "single digit month date",
			args: []string{"--json", "calendar", "working-location", "primary", "--from", "2026-6-15", "--to", "2026-06-15", "--type", "home", "--dry-run"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Execute(tt.args)
			if got := ExitCode(err); got != 2 {
				t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
			}
		})
	}
}
