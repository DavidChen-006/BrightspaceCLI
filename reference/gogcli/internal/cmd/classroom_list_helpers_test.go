package cmd

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestClassroomListJSONEmptyArray(t *testing.T) {
	svc, closeService := newClassroomTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/topics") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"nextPageToken":""}`))
	}))
	defer closeService()

	result := executeWithClassroomTestService(t, []string{"--json", "--account", "a@b.com", "classroom", "topics", "c1"}, svc)
	if result.err != nil {
		t.Fatalf("execute: %v", result.err)
	}
	var payload struct {
		Topics []json.RawMessage `json:"topics"`
	}
	if err := json.Unmarshal([]byte(result.stdout), &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if payload.Topics == nil {
		t.Fatalf("topics should be [], got null in %s", result.stdout)
	}
	if len(payload.Topics) != 0 {
		t.Fatalf("expected no topics, got %d", len(payload.Topics))
	}
}

func TestClassroomDirectListJSONEmptyArray(t *testing.T) {
	tests := []struct {
		name string
		path string
		args []string
		key  string
	}{
		{
			name: "students",
			path: "/courses/c1/students",
			args: []string{"--json", "--account", "a@b.com", "classroom", "students", "c1"},
			key:  "students",
		},
		{
			name: "invitations",
			path: "/invitations",
			args: []string{"--json", "--account", "a@b.com", "classroom", "invitations", "list", "--course", "c1"},
			key:  "invitations",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, closeService := newClassroomTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, tt.path) {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"nextPageToken":""}`))
			}))
			defer closeService()

			result := executeWithClassroomTestService(t, tt.args, svc)
			if result.err != nil {
				t.Fatalf("execute: %v", result.err)
			}
			var payload map[string]json.RawMessage
			if err := json.Unmarshal([]byte(result.stdout), &payload); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if string(payload[tt.key]) != "[]" {
				t.Fatalf("%s should be [], got %s in %s", tt.key, payload[tt.key], result.stdout)
			}
		})
	}
}
