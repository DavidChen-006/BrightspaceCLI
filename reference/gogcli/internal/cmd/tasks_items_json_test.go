package cmd

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTasksItems_JSONPaths(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/tasks/v1/users/@me/lists" && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]any{
					{"id": "l1", "title": "One"},
				},
			})
			return
		case strings.HasSuffix(r.URL.Path, "/tasks/v1/lists/l1/tasks") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items":         []map[string]any{{"id": "t1", "title": "Task"}},
				"nextPageToken": "next",
			})
			return
		case strings.HasSuffix(r.URL.Path, "/tasks/v1/lists/l1/tasks") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "t1", "title": "Task"})
			return
		case strings.HasSuffix(r.URL.Path, "/tasks/v1/lists/l1/tasks/t1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "t1", "title": "Task"})
			return
		case strings.Contains(r.URL.Path, "/tasks/v1/lists/l1/tasks/t1") && r.Method == http.MethodPatch:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "t1", "title": "Task", "status": "completed"})
			return
		case strings.Contains(r.URL.Path, "/tasks/v1/lists/l1/tasks/t1") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "t1", "title": "Task"})
			return
		case strings.Contains(r.URL.Path, "/tasks/v1/lists/l1/tasks/t1") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
			return
		case r.URL.Path == "/tasks/v1/lists/l1/clear" && r.Method == http.MethodPost:
			w.WriteHeader(http.StatusNoContent)
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	flags := &RootFlags{Account: "a@b.com", Force: true}
	ctx := withTasksTestService(
		newCmdRuntimeJSONOutputContext(t, io.Discard, io.Discard),
		newTasksServiceFromServer(t, srv),
	)

	// list
	if err := runKong(t, &TasksListCmd{}, []string{
		"l1",
		"--due-min", "2025-01-01T00:00:00Z",
		"--due-max", "2025-01-02T00:00:00Z",
		"--completed-min", "2025-01-01T00:00:00Z",
		"--completed-max", "2025-01-02T00:00:00Z",
		"--updated-min", "2025-01-01T00:00:00Z",
	}, ctx, flags); err != nil {
		t.Fatalf("list: %v", err)
	}

	// add
	if err := runKong(t, &TasksAddCmd{}, []string{
		"l1",
		"--title", "Task",
	}, ctx, flags); err != nil {
		t.Fatalf("add: %v", err)
	}

	// get
	if err := runKong(t, &TasksGetCmd{}, []string{
		"l1", "t1",
	}, ctx, flags); err != nil {
		t.Fatalf("get: %v", err)
	}

	// update
	if err := runKong(t, &TasksUpdateCmd{}, []string{
		"l1", "t1",
		"--status", "completed",
	}, ctx, flags); err != nil {
		t.Fatalf("update: %v", err)
	}

	// done
	if err := runKong(t, &TasksDoneCmd{}, []string{"l1", "t1"}, ctx, flags); err != nil {
		t.Fatalf("done: %v", err)
	}

	// undo
	if err := runKong(t, &TasksUndoCmd{}, []string{"l1", "t1"}, ctx, flags); err != nil {
		t.Fatalf("undo: %v", err)
	}

	// delete
	if err := runKong(t, &TasksDeleteCmd{}, []string{"l1", "t1"}, ctx, flags); err != nil {
		t.Fatalf("delete: %v", err)
	}

	// clear
	if err := runKong(t, &TasksClearCmd{}, []string{"l1"}, ctx, flags); err != nil {
		t.Fatalf("clear: %v", err)
	}
}

func TestTasksAddCmd_MissingTitle(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com"}
	if err := runKong(t, &TasksAddCmd{}, []string{"l1"}, context.Background(), flags); err == nil {
		t.Fatalf("expected error")
	}
}
