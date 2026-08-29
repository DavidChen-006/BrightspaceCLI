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

func TestCalendarRespondCmd_Text(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/calendar/v3")
		switch {
		case strings.Contains(path, "/calendars/cal1@example.com/events/evt1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "evt1",
				"summary": "Meeting",
				"attendees": []map[string]any{
					{"email": "a@b.com", "self": true},
				},
				// Invalid overrides payload: missing "minutes". Old code PATCHed full event, triggering API validation.
				"reminders": map[string]any{
					"useDefault": false,
					"overrides": []map[string]any{
						{"method": "popup"},
					},
				},
			})
			return
		case strings.Contains(path, "/calendars/cal1@example.com/events/evt1") && r.Method == http.MethodPatch:
			body, _ := io.ReadAll(r.Body)
			var patch map[string]any
			if err := json.Unmarshal(body, &patch); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			if _, ok := patch["reminders"]; ok {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"code":    400,
						"message": "Missing override reminder minutes",
					},
				})
				return
			}
			if _, ok := patch["attendees"]; !ok {
				t.Fatalf("PATCH missing attendees. body=%s", string(body))
			}
			for k := range patch {
				if k != "attendees" {
					t.Fatalf("PATCH should only contain attendees; got key %q. body=%s", k, string(body))
				}
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":       "evt1",
				"summary":  "Meeting",
				"htmlLink": "http://example.com/event",
			})
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

	flags := &RootFlags{Account: "a@b.com"}
	var output bytes.Buffer
	ctx := withCalendarTestService(newCmdRuntimeOutputContext(t, &output, io.Discard), svc)
	cmd := &CalendarRespondCmd{}
	if err := runKong(t, cmd, []string{"cal1@example.com", "evt1", "--status", "accepted", "--comment", "ok"}, ctx, flags); err != nil {
		t.Fatalf("respond: %v", err)
	}
	out := output.String()
	if !strings.Contains(out, "response_status") {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestCalendarRespondCmd_InvalidStatusIsUsageError(t *testing.T) {
	ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)

	cmd := &CalendarRespondCmd{}
	err := runKong(t, cmd, []string{"primary", "evt1", "--status", "maybe"}, ctx, &RootFlags{Account: "a@b.com"})
	if err == nil || !strings.Contains(err.Error(), "invalid status") {
		t.Fatalf("expected invalid status error, got: %v", err)
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
	}
}

func TestCalendarRespondCmd_AttendeeValidationIsUsage(t *testing.T) {
	tests := []struct {
		name      string
		attendees []map[string]any
		wantErr   string
	}{
		{
			name:      "no attendees",
			attendees: nil,
			wantErr:   "event has no attendees",
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
			wantErr: "cannot respond to your own event (you are the organizer)",
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
						"summary": "Meeting",
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

			cmd := &CalendarRespondCmd{}
			err = runKong(t, cmd, []string{"cal1@example.com", "evt1", "--status", "accepted"}, ctx, &RootFlags{Account: "a@b.com"})
			if err == nil {
				t.Fatal("expected attendee validation error")
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
