package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/drivelabels/v2"
)

func TestDriveLabelsList_JSON(t *testing.T) {
	svc, closeSvc := newGoogleTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v2/labels" {
			http.NotFound(w, r)
			return
		}
		requireQuery(t, r, "publishedOnly", "true")
		requireQuery(t, r, "view", "LABEL_VIEW_BASIC")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"labels": []map[string]any{{
				"name":       "labels/abc",
				"id":         "abc",
				"revisionId": "1",
				"labelType":  "SHARED",
				"properties": map[string]any{"title": "Project"},
				"lifecycle":  map[string]any{"state": "PUBLISHED"},
			}},
		})
	}), drivelabels.NewService)
	defer closeSvc()

	var stdout bytes.Buffer
	ctx := withDriveLabelsTestService(newCmdRuntimeJSONOutputContext(t, &stdout, io.Discard), svc)
	if err := (&DriveLabelsListCmd{Max: 50, PublishedOnly: true, View: "LABEL_VIEW_BASIC"}).Run(ctx, &RootFlags{Account: "a@example.com"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	out := stdout.String()
	var parsed struct {
		LabelCount int `json:"labelCount"`
		Labels     []struct {
			Name string `json:"name"`
		} `json:"labels"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("json parse: %v\n%s", err, out)
	}
	if parsed.LabelCount != 1 || len(parsed.Labels) != 1 || parsed.Labels[0].Name != "labels/abc" {
		t.Fatalf("unexpected output: %#v", parsed)
	}
}

func TestDriveLabelsListInvalidMaxFailsBeforeService(t *testing.T) {
	ctx := withDriveLabelsTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		unexpectedDriveLabelsTestService(t, "expected max validation to fail before creating drive labels service"),
	)
	flags := &RootFlags{Account: "a@example.com"}

	for _, args := range [][]string{{"--max", "0"}, {"--max=-1"}} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			cmd := &DriveLabelsListCmd{}
			err := runKong(t, cmd, args, ctx, flags)
			var exitErr *ExitError
			if !errors.As(err, &exitErr) || exitErr.Code != 2 || !strings.Contains(err.Error(), "max must be > 0") {
				t.Fatalf("unexpected err: %v", err)
			}
		})
	}
}

func TestNormalizeDriveLabelName(t *testing.T) {
	if got := normalizeDriveLabelName("abc"); got != "labels/abc" {
		t.Fatalf("unexpected: %q", got)
	}
	if got := normalizeDriveLabelName("labels/abc"); got != "labels/abc" {
		t.Fatalf("unexpected: %q", got)
	}
}

func TestDriveLabelsFileList_JSON(t *testing.T) {
	t.Parallel()

	svc, closeSvc := newDriveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/files/file1/listLabels" {
			http.NotFound(w, r)
			return
		}
		requireQuery(t, r, "maxResults", "10")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"labels": []map[string]any{{"id": "label1", "revisionId": "2"}},
		})
	}))
	defer closeSvc()

	var stdout bytes.Buffer
	ctx := withDriveTestService(newCmdRuntimeJSONOutputContext(t, &stdout, io.Discard), svc)
	if err := (&DriveLabelsFileListCmd{FileID: "file1", Max: 10}).Run(ctx, &RootFlags{Account: "a@example.com"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out := stdout.String(); !strings.Contains(out, `"labelCount": 1`) || !strings.Contains(out, "label1") {
		t.Fatalf("unexpected output: %s", out)
	}
}

func TestDriveLabelsFileListInvalidMaxFailsBeforeService(t *testing.T) {
	ctx := withDriveTestServiceFactory(newCmdOutputContext(t, io.Discard, io.Discard), func(context.Context, string) (*drive.Service, error) {
		t.Fatalf("expected max validation to fail before creating drive service")
		return nil, errUnexpectedDriveServiceCall
	})
	flags := &RootFlags{Account: "a@example.com"}

	for _, args := range [][]string{{"file1", "--max", "0"}, {"file1", "--max=-1"}} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			cmd := &DriveLabelsFileListCmd{}
			err := runKong(t, cmd, args, ctx, flags)
			var exitErr *ExitError
			if !errors.As(err, &exitErr) || exitErr.Code != 2 || !strings.Contains(err.Error(), "max must be > 0") {
				t.Fatalf("unexpected err: %v", err)
			}
		})
	}
}

func TestDriveLabelsFileApply_BuildsModifyLabelsRequest(t *testing.T) {
	svc, closeSvc := newDriveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/files/file1/modifyLabels" {
			http.NotFound(w, r)
			return
		}
		var req drive.ModifyLabelsRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
			t.Fatalf("decode body: %v", err)
		}
		if len(req.LabelModifications) != 1 || req.LabelModifications[0].LabelId != "label1" {
			t.Fatalf("unexpected request: %#v", req)
		}
		fields := req.LabelModifications[0].FieldModifications
		if len(fields) != 2 || fields[0].FieldId != "title" || fields[0].SetTextValues[0] != "Project" || !fields[1].UnsetValues {
			t.Fatalf("unexpected fields: %#v", fields)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"modifiedLabels": []map[string]any{{"id": "label1"}},
		})
	}))
	defer closeSvc()

	ctx := withDriveTestService(newCmdOutputContext(t, io.Discard, io.Discard), svc)
	if err := (&DriveLabelsFileApplyCmd{
		FileID:  "file1",
		LabelID: "labels/label1",
		Text:    []string{"title=Project"},
		Unset:   []string{"old"},
	}).Run(ctx, &RootFlags{Account: "a@example.com", Force: true}); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestDriveLabelsFileApply_InvalidIntegerIsUsageError(t *testing.T) {
	err := (&DriveLabelsFileApplyCmd{
		FileID:  "file1",
		LabelID: "label1",
		Integer: []string{"count=abc"},
	}).Run(newCmdOutputContext(t, io.Discard, io.Discard), &RootFlags{Account: "a@example.com", DryRun: true})
	if err == nil || !strings.Contains(err.Error(), "invalid integer label value") {
		t.Fatalf("expected invalid integer error, got: %v", err)
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
	}
}

func TestDriveLabelsFileApply_InvalidFieldsJSONIsUsageError(t *testing.T) {
	err := (&DriveLabelsFileApplyCmd{
		FileID:     "file1",
		LabelID:    "label1",
		FieldsJSON: "nope",
	}).Run(newCmdOutputContext(t, io.Discard, io.Discard), &RootFlags{Account: "a@example.com", DryRun: true})
	if err == nil || !strings.Contains(err.Error(), "parse --fields-json") {
		t.Fatalf("expected invalid fields-json error, got: %v", err)
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
	}
}

func TestDriveLabelsFileApply_RejectsMalformedFieldMods(t *testing.T) {
	tests := []struct {
		name string
		cmd  DriveLabelsFileApplyCmd
		want string
	}{
		{
			name: "fractional json integer",
			cmd:  DriveLabelsFileApplyCmd{FileID: "file1", LabelID: "label1", FieldsJSON: `{"count":1.5}`},
			want: "invalid integer label value",
		},
		{
			name: "trailing json token",
			cmd:  DriveLabelsFileApplyCmd{FileID: "file1", LabelID: "label1", FieldsJSON: `{"count":1} true`},
			want: "trailing JSON value",
		},
		{
			name: "invalid date",
			cmd:  DriveLabelsFileApplyCmd{FileID: "file1", LabelID: "label1", Date: []string{"due=not-a-date"}},
			want: "invalid date label value",
		},
		{
			name: "invalid user email",
			cmd:  DriveLabelsFileApplyCmd{FileID: "file1", LabelID: "label1", User: []string{"owner=nope"}},
			want: "invalid --user",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cmd.Run(newCmdOutputContext(t, io.Discard, io.Discard), &RootFlags{Account: "a@example.com", DryRun: true})
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected %q error, got: %v", tt.want, err)
			}
			if got := ExitCode(err); got != 2 {
				t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
			}
		})
	}
}

func TestWrapDriveLabelsErrorValidCustomer(t *testing.T) {
	err := wrapDriveLabelsError(errors.New("Cannot perform this action without a valid customer"))
	if err == nil || !strings.Contains(err.Error(), "requires a Google Workspace customer") {
		t.Fatalf("unexpected error: %v", err)
	}
}
