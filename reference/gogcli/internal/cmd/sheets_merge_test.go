package cmd

import (
	"io"
	"strings"
	"testing"
)

func TestSheetsMergeCmds(t *testing.T) {
	capture := &sheetsBatchUpdateCapture{}
	svc := newSheetsBatchUpdateTestService(t, map[string]any{
		"sheets": []map[string]any{{"properties": map[string]any{"sheetId": 9, "title": "Sheet1"}}},
	}, capture)

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSheetsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	t.Run("merge", func(t *testing.T) {
		capture.reset()
		cmd := &SheetsMergeCmd{}
		if err := runKong(t, cmd, []string{"s1", "Sheet1!A1:B2", "--type", "merge_rows"}, ctx, flags); err != nil {
			t.Fatalf("merge: %v", err)
		}
		if capture.Last == nil || capture.Last.MergeCells == nil {
			t.Fatalf("expected merge request, got %#v", capture.Last)
		}
		if capture.Last.MergeCells.MergeType != "MERGE_ROWS" {
			t.Fatalf("unexpected merge type: %#v", capture.Last.MergeCells)
		}
	})

	t.Run("unmerge", func(t *testing.T) {
		capture.reset()
		cmd := &SheetsUnmergeCmd{}
		if err := runKong(t, cmd, []string{"s1", "Sheet1!A1:B2"}, ctx, flags); err != nil {
			t.Fatalf("unmerge: %v", err)
		}
		if capture.Last == nil || capture.Last.UnmergeCells == nil {
			t.Fatalf("expected unmerge request, got %#v", capture.Last)
		}
	})

	t.Run("invalid merge type is usage", func(t *testing.T) {
		capture.reset()
		cmd := &SheetsMergeCmd{}
		err := runKong(t, cmd, []string{"s1", "Sheet1!A1:B2", "--type", "BOGUS"}, ctx, flags)
		if err == nil || !strings.Contains(err.Error(), "invalid --type") {
			t.Fatalf("expected invalid type error, got %v", err)
		}
		if got := ExitCode(err); got != 2 {
			t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
		}
		if capture.Last != nil {
			t.Fatal("did not expect an API request")
		}
	})
}
