package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/driveactivity/v2"
)

func TestDriveChangesStartToken(t *testing.T) {
	svc, closeSrv := newDriveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/changes/startPageToken" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		requireQuery(t, r, "supportsAllDrives", "true")
		_ = json.NewEncoder(w).Encode(map[string]any{"startPageToken": "123"})
	}))
	defer closeSrv()

	ctx := withDriveTestService(newCmdOutputContext(t, io.Discard, io.Discard), svc)
	if err := (&DriveChangesStartTokenCmd{}).Run(ctx, &RootFlags{Account: "a@example.com"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestDriveChangesList(t *testing.T) {
	svc, closeSrv := newDriveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/changes" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		requireQuery(t, r, "pageToken", "123")
		requireQuery(t, r, "includeItemsFromAllDrives", "true")
		requireQuery(t, r, "supportsAllDrives", "true")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"newStartPageToken": "456",
			"changes": []map[string]any{{
				"type":   "file",
				"fileId": "file1",
				"file":   map[string]any{"id": "file1", "name": "Doc"},
			}},
		})
	}))
	defer closeSrv()

	ctx := withDriveTestService(newCmdOutputContext(t, io.Discard, io.Discard), svc)
	if err := (&DriveChangesListCmd{Token: "123", Max: 10, IncludeRemoved: true}).Run(ctx, &RootFlags{Account: "a@example.com"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestDriveChangesListInvalidMaxFailsBeforeService(t *testing.T) {
	ctx := withDriveTestServiceFactory(newCmdOutputContext(t, io.Discard, io.Discard), func(context.Context, string) (*drive.Service, error) {
		t.Fatalf("expected max validation to fail before creating drive service")
		return nil, errUnexpectedDriveServiceCall
	})
	flags := &RootFlags{Account: "a@example.com"}

	for _, args := range [][]string{{"--token", "123", "--max", "0"}, {"--token", "123", "--max=-1"}} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			cmd := &DriveChangesListCmd{}
			err := runKong(t, cmd, args, ctx, flags)
			var exitErr *ExitError
			if !errors.As(err, &exitErr) || exitErr.Code != 2 || !strings.Contains(err.Error(), "max must be > 0") {
				t.Fatalf("unexpected err: %v", err)
			}
		})
	}
}

func TestDriveChangesWatchValidationBeforeDryRun(t *testing.T) {
	ctx := withDriveTestServiceFactory(newCmdOutputContext(t, io.Discard, io.Discard), func(context.Context, string) (*drive.Service, error) {
		t.Fatal("drive service should not be created")
		return nil, context.Canceled
	})

	cases := []struct {
		name string
		cmd  DriveChangesWatchCmd
	}{
		{
			name: "missing scheme",
			cmd:  DriveChangesWatchCmd{Token: "t1", WebhookURL: "nope"},
		},
		{
			name: "http url",
			cmd:  DriveChangesWatchCmd{Token: "t1", WebhookURL: "http://example.com/hook"},
		},
		{
			name: "negative expiration",
			cmd:  DriveChangesWatchCmd{Token: "t1", WebhookURL: "https://example.com/hook", ExpirationMS: -1},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.cmd.Run(ctx, &RootFlags{Account: "a@example.com", DryRun: true})
			if err == nil {
				t.Fatal("expected validation error")
			}
			if got := ExitCode(err); got != 2 {
				t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
			}
		})
	}
}

func TestDriveActivityFilter(t *testing.T) {
	filter, err := driveActivityFilter("edit,share", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", `detail.action_detail_case:-MOVE`)
	if err != nil {
		t.Fatalf("driveActivityFilter: %v", err)
	}
	for _, want := range []string{
		`time >= "2026-01-01T00:00:00Z"`,
		`time <= "2026-01-02T00:00:00Z"`,
		"detail.action_detail_case:(EDIT PERMISSION_CHANGE)",
		"detail.action_detail_case:-MOVE",
	} {
		if !strings.Contains(filter, want) {
			t.Fatalf("filter %q missing %q", filter, want)
		}
	}
}

func TestDriveActivityQuery(t *testing.T) {
	svc, closeSrv := newGoogleTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/activity:query" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		var req driveactivity.QueryDriveActivityRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if req.ItemName != "items/file1" || !strings.Contains(req.Filter, "EDIT") {
			t.Fatalf("unexpected request: %#v", req)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"activities": []map[string]any{{
				"timestamp":           "2026-01-01T00:00:00Z",
				"primaryActionDetail": map[string]any{"edit": map[string]any{}},
				"targets":             []map[string]any{{"driveItem": map[string]any{"name": "items/file1", "title": "Doc"}}},
			}},
		})
	}), driveactivity.NewService)
	defer closeSrv()

	ctx := withDriveActivityTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	if err := (&DriveActivityQueryCmd{File: "file1", Actions: "edit", Max: 10}).Run(ctx, &RootFlags{Account: "a@example.com"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestDriveActivityQueryValidationFailsBeforeService(t *testing.T) {
	ctx := withDriveActivityTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		unexpectedDriveActivityTestService(t, "expected validation to fail before creating drive activity service"),
	)
	flags := &RootFlags{Account: "a@example.com"}

	cases := []struct {
		name string
		args []string
		want string
	}{
		{name: "zero max", args: []string{"--max", "0"}, want: "max must be > 0"},
		{name: "negative max", args: []string{"--max=-1"}, want: "max must be > 0"},
		{name: "unknown action", args: []string{"--actions", "nope"}, want: "unknown Drive Activity action"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd := &DriveActivityQueryCmd{}
			err := runKong(t, cmd, tc.args, ctx, flags)
			var exitErr *ExitError
			if !errors.As(err, &exitErr) || exitErr.Code != 2 || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("unexpected err: %v", err)
			}
		})
	}
}

var _ = drive.Change{}
