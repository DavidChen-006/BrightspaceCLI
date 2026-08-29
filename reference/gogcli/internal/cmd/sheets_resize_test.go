package cmd

import (
	"context"
	"io"
	"testing"
)

func TestSheetsResizeCmds(t *testing.T) {
	capture := &sheetsBatchUpdateCapture{}
	svc := newSheetsBatchUpdateTestService(t, map[string]any{
		"sheets": []map[string]any{{"properties": map[string]any{"sheetId": 0, "title": "Sheet1"}}},
	}, capture)

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSheetsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	t.Run("resize columns force-sends zero sheet and start index", func(t *testing.T) {
		capture.reset()
		cmd := &SheetsResizeColumnsCmd{}
		if err := runKong(t, cmd, []string{"s1", "A:C", "--width", "120"}, ctx, flags); err != nil {
			t.Fatalf("resize-columns: %v", err)
		}
		requests := capture.Body["requests"].([]any)
		update := requests[0].(map[string]any)["updateDimensionProperties"].(map[string]any)
		rng := update["range"].(map[string]any)
		if _, ok := rng["sheetId"]; !ok {
			t.Fatalf("expected sheetId to be sent: %#v", rng)
		}
		if v, ok := rng["startIndex"]; !ok || v != float64(0) {
			t.Fatalf("expected startIndex=0, got %#v", rng)
		}
		if v, ok := rng["endIndex"]; !ok || v != float64(3) {
			t.Fatalf("expected endIndex=3, got %#v", rng)
		}
	})

	t.Run("resize rows auto", func(t *testing.T) {
		capture.reset()
		cmd := &SheetsResizeRowsCmd{}
		if err := runKong(t, cmd, []string{"s1", "1:3", "--auto"}, ctx, flags); err != nil {
			t.Fatalf("resize-rows: %v", err)
		}
		requests := capture.Body["requests"].([]any)
		auto := requests[0].(map[string]any)["autoResizeDimensions"].(map[string]any)
		rng := auto["dimensions"].(map[string]any)
		if _, ok := rng["sheetId"]; !ok {
			t.Fatalf("expected sheetId to be sent: %#v", rng)
		}
		if v, ok := rng["startIndex"]; !ok || v != float64(0) {
			t.Fatalf("expected startIndex=0, got %#v", rng)
		}
		if v, ok := rng["endIndex"]; !ok || v != float64(3) {
			t.Fatalf("expected endIndex=3, got %#v", rng)
		}
	})
}

func TestSheetsResizeCmds_InvalidRangesAreUsageErrors(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com"}
	for _, tc := range []struct {
		name string
		cmd  any
		args []string
	}{
		{
			name: "columns",
			cmd:  &SheetsResizeColumnsCmd{},
			args: []string{"s1", "1:3", "--width", "120"},
		},
		{
			name: "rows",
			cmd:  &SheetsResizeRowsCmd{},
			args: []string{"s1", "A:C", "--height", "24"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := runKong(t, tc.cmd, tc.args, context.Background(), flags)
			if err == nil {
				t.Fatal("expected error")
			}
			if got := ExitCode(err); got != 2 {
				t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
			}
		})
	}
}
