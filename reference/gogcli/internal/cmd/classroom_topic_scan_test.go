package cmd

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestClassroomTopicList_ScanPages(t *testing.T) {
	tests := []struct {
		name        string
		path        string
		responseKey string
		command     string
		firstID     string
		wantID      string
	}{
		{name: "coursework", path: "/courseWork", responseKey: "courseWork", command: "coursework", firstID: "w1", wantID: "w2"},
		{name: "materials", path: "/courseWorkMaterials", responseKey: "courseWorkMaterial", command: "materials", firstID: "m1", wantID: "m2"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			svc, closeService := newClassroomTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, tc.path) {
					http.NotFound(w, r)
					return
				}
				calls++
				id, topic, next := tc.firstID, "other", "p2"
				if calls == 2 {
					id, topic, next = tc.wantID, "target", ""
				} else if calls > 2 {
					t.Fatalf("unexpected calls: %d", calls)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					tc.responseKey:  []map[string]any{{"id": id, "topicId": topic}},
					"nextPageToken": next,
				})
			}))
			defer closeService()

			result := executeWithClassroomTestService(t, []string{
				"--json", "--account", "a@b.com", "classroom", tc.command, "c1", "--topic", "target", "--scan-pages", "2",
			}, svc)
			if result.err != nil {
				t.Fatalf("execute: %v", result.err)
			}
			var payload map[string]any
			if err := json.Unmarshal([]byte(result.stdout), &payload); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			items := payload[tc.command].([]any)
			if len(items) != 1 || items[0].(map[string]any)["id"] != tc.wantID {
				t.Fatalf("unexpected items: %#v", items)
			}
			if calls != 2 {
				t.Fatalf("expected 2 calls, got %d", calls)
			}
		})
	}
}
