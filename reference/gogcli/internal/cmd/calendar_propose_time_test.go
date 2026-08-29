package cmd

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/option"
)

func TestProposeTimeURLGeneration(t *testing.T) {
	tests := []struct {
		name       string
		eventID    string
		calendarID string
		wantURL    string
	}{
		{
			name:       "basic event",
			eventID:    "rp2rg301pirvlufurh62sfkh74",
			calendarID: "vladimir.novosselov@gmail.com",
			wantURL:    "https://calendar.google.com/calendar/u/0/r/proposetime/cnAycmczMDFwaXJ2bHVmdXJoNjJzZmtoNzQgdmxhZGltaXIubm92b3NzZWxvdkBnbWFpbC5jb20=",
		},
		{
			name:       "simple ids",
			eventID:    "evt123",
			calendarID: "test@example.com",
			wantURL:    "https://calendar.google.com/calendar/u/0/r/proposetime/" + base64.StdEncoding.EncodeToString([]byte("evt123 test@example.com")),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payload := tt.eventID + " " + tt.calendarID
			encoded := base64.StdEncoding.EncodeToString([]byte(payload))
			got := "https://calendar.google.com/calendar/u/0/r/proposetime/" + encoded

			if got != tt.wantURL {
				t.Errorf("URL mismatch:\ngot:  %s\nwant: %s", got, tt.wantURL)
			}
		})
	}
}

func TestCalendarProposeTimeCmd_Text(t *testing.T) {
	var browserOpened string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/calendar/v3")
		if strings.Contains(path, "/calendars/cal1@example.com/events/evt1") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "evt1",
				"summary": "Team Meeting",
				"start":   map[string]string{"dateTime": "2026-01-16T19:30:00-08:00"},
				"end":     map[string]string{"dateTime": "2026-01-16T20:30:00-08:00"},
				"attendees": []map[string]any{
					{"email": "a@b.com", "self": true},
					{"email": "organizer@b.com", "organizer": true},
				},
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
	var output bytes.Buffer
	ctx := withCalendarTestService(newCmdRuntimeOutputContext(t, &output, io.Discard), svc)
	cmd := &CalendarProposeTimeCmd{openBrowser: func(_ context.Context, url string) error {
		browserOpened = url
		return nil
	}}
	if err := runKong(t, cmd, []string{"cal1@example.com", "evt1", "--open"}, ctx, flags); err != nil {
		t.Fatalf("propose-time: %v", err)
	}
	out := output.String()

	// Verify output contains expected fields
	if !strings.Contains(out, "propose_url") {
		t.Errorf("output missing propose_url: %q", out)
	}
	if !strings.Contains(out, "Team Meeting") {
		t.Errorf("output missing event summary: %q", out)
	}
	if !strings.Contains(out, "proposetime/") {
		t.Errorf("output missing proposetime URL path: %q", out)
	}
	if !strings.Contains(out, proposeTimeIssueTrackerURL) {
		t.Errorf("output missing issue tracker URL: %q", out)
	}
	if !strings.Contains(out, "API Limitation: "+proposeTimeAPILimitation) {
		t.Errorf("output missing API limitation message: %q", out)
	}
	if !strings.Contains(out, "Action: "+proposeTimeUpvoteAction) {
		t.Errorf("output missing upvote action: %q", out)
	}

	// Verify browser was opened
	if browserOpened == "" {
		t.Error("browser was not opened despite --open flag")
	}
	if !strings.Contains(browserOpened, "proposetime/") {
		t.Errorf("browser URL incorrect: %q", browserOpened)
	}
}

func TestCalendarProposeTimeCmd_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/calendar/v3")
		if strings.Contains(path, "/calendars/cal1@example.com/events/evt1") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "evt1",
				"summary": "Team Meeting",
				"start":   map[string]string{"dateTime": "2026-01-16T19:30:00-08:00"},
				"end":     map[string]string{"dateTime": "2026-01-16T20:30:00-08:00"},
				"attendees": []map[string]any{
					{"email": "a@b.com", "self": true},
					{"email": "organizer@b.com", "organizer": true},
				},
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

	flags := &RootFlags{Account: "a@b.com", JSON: true}
	var output bytes.Buffer
	ctx := withCalendarTestService(newCmdRuntimeJSONOutputContext(t, &output, io.Discard), svc)
	cmd := &CalendarProposeTimeCmd{}
	if err := runKong(t, cmd, []string{"cal1@example.com", "evt1"}, ctx, flags); err != nil {
		t.Fatalf("propose-time JSON: %v", err)
	}
	out := output.String()

	// Parse and verify JSON structure
	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("failed to parse JSON output: %v\noutput: %s", err, out)
	}

	// Verify required fields
	requiredFields := []string{"event_id", "calendar_id", "summary", "propose_url", "api_limitation", "issue_tracker_url", "upvote_action", "current_start", "current_end"}
	for _, field := range requiredFields {
		if _, ok := result[field]; !ok {
			t.Errorf("JSON missing required field %q", field)
		}
	}

	if result["event_id"] != "evt1" {
		t.Errorf("event_id = %v, want evt1", result["event_id"])
	}
	if result["calendar_id"] != "cal1@example.com" {
		t.Errorf("calendar_id = %v, want cal1@example.com", result["calendar_id"])
	}
	if result["summary"] != "Team Meeting" {
		t.Errorf("summary = %v, want Team Meeting", result["summary"])
	}
	proposeURL, ok := result["propose_url"].(string)
	if !ok || !strings.Contains(proposeURL, "proposetime/") {
		t.Errorf("propose_url invalid: %v", result["propose_url"])
	}
}

func TestCalendarProposeTimeCmd_DeclineValidationIsUsage(t *testing.T) {
	tests := []struct {
		name      string
		attendees []map[string]any
		wantErr   string
	}{
		{
			name:      "no attendees",
			attendees: nil,
			wantErr:   "event has no attendees, cannot decline",
		},
		{
			name: "self missing",
			attendees: []map[string]any{
				{"email": "organizer@b.com", "organizer": true},
				{"email": "guest@b.com"},
			},
			wantErr: "you are not an attendee of this event",
		},
		{
			name: "self organizer",
			attendees: []map[string]any{
				{"email": "a@b.com", "self": true, "organizer": true},
			},
			wantErr: "cannot decline your own event (you are the organizer)",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				path := strings.TrimPrefix(r.URL.Path, "/calendar/v3")
				if strings.Contains(path, "/calendars/cal1@example.com/events/evt1") && r.Method == http.MethodGet {
					w.Header().Set("Content-Type", "application/json")
					body := map[string]any{
						"id":      "evt1",
						"summary": "Team Meeting",
					}
					if tt.attendees != nil {
						body["attendees"] = tt.attendees
					}
					_ = json.NewEncoder(w).Encode(body)
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

			ctx := withCalendarTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
			flags := &RootFlags{Account: "a@b.com"}

			cmd := &CalendarProposeTimeCmd{}
			err = runKong(t, cmd, []string{"cal1@example.com", "evt1", "--decline"}, ctx, flags)
			if err == nil {
				t.Fatal("expected decline validation error")
			}
			if got := ExitCode(err); got != 2 {
				t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want %q", err, tt.wantErr)
			}
		})
	}
}

func TestCalendarProposeTimeCmd_WithDecline(t *testing.T) {
	var patchCalled bool
	var patchedComment string
	var sendUpdates string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/calendar/v3")
		switch {
		case strings.Contains(path, "/calendars/cal1@example.com/events/evt1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "evt1",
				"summary": "Team Meeting",
				"start":   map[string]string{"dateTime": "2026-01-16T19:30:00-08:00"},
				"end":     map[string]string{"dateTime": "2026-01-16T20:30:00-08:00"},
				"attendees": []map[string]any{
					{"email": "a@b.com", "self": true},
					{"email": "organizer@b.com", "organizer": true},
				},
			})
		case strings.Contains(path, "/calendars/cal1@example.com/events/evt1") && r.Method == http.MethodPatch:
			patchCalled = true
			sendUpdates = r.URL.Query().Get("sendUpdates")
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if attendees, ok := body["attendees"].([]any); ok && len(attendees) > 0 {
				if att, ok := attendees[0].(map[string]any); ok {
					if c, ok := att["comment"].(string); ok {
						patchedComment = c
					}
				}
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "evt1", "summary": "Team Meeting"})
		default:
			http.NotFound(w, r)
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

	flags := &RootFlags{Account: "a@b.com"}
	var output bytes.Buffer
	ctx := withCalendarTestService(newCmdRuntimeOutputContext(t, &output, io.Discard), svc)
	cmd := &CalendarProposeTimeCmd{}
	if err := runKong(t, cmd, []string{"cal1@example.com", "evt1", "--comment", "Can we do 5pm instead?"}, ctx, flags); err != nil {
		t.Fatalf("propose-time with decline: %v", err)
	}
	out := output.String()

	if !patchCalled {
		t.Error("PATCH was not called despite --comment flag")
	}
	if sendUpdates != "all" {
		t.Errorf("expected sendUpdates=all, got %q", sendUpdates)
	}
	if patchedComment != "Can we do 5pm instead?" {
		t.Errorf("comment not passed correctly, got: %q", patchedComment)
	}
	if !strings.Contains(out, "declined\tyes") {
		t.Errorf("output should show declined status: %q", out)
	}
}
