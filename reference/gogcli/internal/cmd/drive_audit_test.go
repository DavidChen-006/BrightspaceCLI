package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestDriveAuditSharingFindsPublicAndExternal(t *testing.T) {
	svc, closeSvc := newDriveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/files"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"files": []map[string]any{{
					"id":       "file1",
					"name":     "Shared Doc",
					"mimeType": "text/plain",
					"owners":   []map[string]any{{"emailAddress": "owner@example.com"}},
				}},
			})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/files/file1/permissions"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"permissions": []map[string]any{
					{"id": "anyone", "type": "anyone", "role": "reader"},
					{"id": "user1", "type": "user", "role": "writer", "emailAddress": "a@external.test"},
					{"id": "user2", "type": "user", "role": "reader", "emailAddress": "b@example.com"},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer closeSvc()

	var stdout bytes.Buffer
	ctx := withDriveTestService(newCmdRuntimeJSONOutputContext(t, &stdout, io.Discard), svc)
	if err := (&DriveAuditSharingCmd{Parent: "root", Depth: 1, Max: 10}).Run(ctx, &RootFlags{Account: "owner@example.com"}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var parsed struct {
		FindingCount int `json:"findingCount"`
		Findings     []struct {
			PermissionID string   `json:"permissionId"`
			Reasons      []string `json:"reasons"`
		} `json:"findings"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		t.Fatalf("json parse: %v\n%s", err, stdout.String())
	}
	if parsed.FindingCount != 2 {
		t.Fatalf("finding count = %d, want 2: %#v", parsed.FindingCount, parsed.Findings)
	}
	if parsed.Findings[0].PermissionID != "anyone" || parsed.Findings[1].PermissionID != "user1" {
		t.Fatalf("unexpected findings: %#v", parsed.Findings)
	}
}
