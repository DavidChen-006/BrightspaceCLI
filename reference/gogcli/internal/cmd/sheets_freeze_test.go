package cmd

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestSheetsFreezeCmd(t *testing.T) {
	capture := &sheetsBatchUpdateCapture{}
	svc := newSheetsBatchUpdateTestService(t, map[string]any{
		"sheets": []map[string]any{{"properties": map[string]any{"sheetId": 0, "title": "Sheet1"}}},
	}, capture)

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSheetsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	cmd := &SheetsFreezeCmd{}
	if err := runKong(t, cmd, []string{"s1", "--rows", "0", "--cols", "2"}, ctx, flags); err != nil {
		t.Fatalf("freeze: %v", err)
	}

	requests, ok := capture.Body["requests"].([]any)
	if !ok || len(requests) != 1 {
		t.Fatalf("unexpected requests: %#v", capture.Body)
	}
	update := requests[0].(map[string]any)["updateSheetProperties"].(map[string]any)
	props := update["properties"].(map[string]any)
	if _, ok := props["sheetId"]; !ok {
		t.Fatalf("expected sheetId to be force-sent: %#v", props)
	}
	gridProps := props["gridProperties"].(map[string]any)
	if v, ok := gridProps["frozenRowCount"]; !ok || v != float64(0) {
		t.Fatalf("expected frozenRowCount=0, got %#v", gridProps)
	}
	if v, ok := gridProps["frozenColumnCount"]; !ok || v != float64(2) {
		t.Fatalf("expected frozenColumnCount=2, got %#v", gridProps)
	}
}

func TestSheetsFreezeCmdRejectsNegativeProvidedCounts(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{
			name: "rows",
			args: []string{"s1", "--rows=-1"},
			want: "--rows must be >= 0",
		},
		{
			name: "cols",
			args: []string{"s1", "--cols=-1"},
			want: "--cols must be >= 0",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := runKong(t, &SheetsFreezeCmd{}, tc.args, context.Background(), &RootFlags{})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q error, got %v", tc.want, err)
			}
		})
	}
}
