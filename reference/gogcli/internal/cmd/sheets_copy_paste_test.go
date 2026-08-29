package cmd

import (
	"io"
	"strings"
	"testing"
)

func TestSheetsCopyPasteCmd(t *testing.T) {
	capture := &sheetsBatchUpdateCapture{}
	svc := newSheetsBatchUpdateTestService(t, map[string]any{
		"sheets": []map[string]any{{"properties": map[string]any{"sheetId": 9, "title": "Sheet1"}}},
	}, capture)

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSheetsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	t.Run("fill formulas down (formula paste type)", func(t *testing.T) {
		capture.reset()
		cmd := &SheetsCopyPasteCmd{}
		if err := runKong(t, cmd, []string{
			"s1", "Sheet1!A2:H71", "Sheet1!A2:H120", "--type", "FORMULA",
		}, ctx, flags); err != nil {
			t.Fatalf("copy-paste: %v", err)
		}
		if capture.Last == nil || capture.Last.CopyPaste == nil {
			t.Fatalf("expected copyPaste request, got %#v", capture.Last)
		}
		cp := capture.Last.CopyPaste
		if cp.PasteType != "PASTE_FORMULA" {
			t.Fatalf("unexpected paste type: %s", cp.PasteType)
		}
		if cp.PasteOrientation != "NORMAL" {
			t.Fatalf("unexpected orientation: %s", cp.PasteOrientation)
		}
		if cp.Source.SheetId != 9 || cp.Destination.SheetId != 9 {
			t.Fatalf("unexpected sheet ids: src=%d dst=%d", cp.Source.SheetId, cp.Destination.SheetId)
		}
		// A2:H71 -> rows [1,71); A2:H120 -> rows [1,120). Destination is taller (fill-down).
		if cp.Source.StartRowIndex != 1 || cp.Source.EndRowIndex != 71 {
			t.Fatalf("unexpected source rows: %#v", cp.Source)
		}
		if cp.Destination.StartRowIndex != 1 || cp.Destination.EndRowIndex != 120 {
			t.Fatalf("unexpected dest rows: %#v", cp.Destination)
		}
	})

	t.Run("default type is PASTE_NORMAL", func(t *testing.T) {
		capture.reset()
		cmd := &SheetsCopyPasteCmd{}
		if err := runKong(t, cmd, []string{"s1", "Sheet1!A1:B2", "Sheet1!D1:E2"}, ctx, flags); err != nil {
			t.Fatalf("copy-paste: %v", err)
		}
		if capture.Last == nil || capture.Last.CopyPaste == nil {
			t.Fatal("expected copyPaste request")
		}
		if capture.Last.CopyPaste.PasteType != "PASTE_NORMAL" {
			t.Fatalf("unexpected paste type: %s", capture.Last.CopyPaste.PasteType)
		}
	})

	t.Run("transpose sets orientation", func(t *testing.T) {
		capture.reset()
		cmd := &SheetsCopyPasteCmd{}
		if err := runKong(t, cmd, []string{"s1", "Sheet1!A1:B3", "Sheet1!D1:F2", "--transpose"}, ctx, flags); err != nil {
			t.Fatalf("copy-paste: %v", err)
		}
		if capture.Last == nil || capture.Last.CopyPaste == nil {
			t.Fatal("expected copyPaste request")
		}
		if capture.Last.CopyPaste.PasteOrientation != "TRANSPOSE" {
			t.Fatalf("unexpected orientation: %s", capture.Last.CopyPaste.PasteOrientation)
		}
	})

	t.Run("invalid paste type", func(t *testing.T) {
		capture.reset()
		cmd := &SheetsCopyPasteCmd{}
		err := runKong(t, cmd, []string{"s1", "Sheet1!A1:B2", "Sheet1!D1:E2", "--type", "BOGUS"}, ctx, flags)
		if err == nil {
			t.Fatal("expected error for invalid type")
		}
		if !strings.Contains(err.Error(), "invalid --type") {
			t.Fatalf("unexpected error: %v", err)
		}
		if got := ExitCode(err); got != 2 {
			t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
		}
		if capture.Last != nil {
			t.Fatal("did not expect an API request")
		}
	})

	t.Run("empty source range", func(t *testing.T) {
		cmd := &SheetsCopyPasteCmd{}
		err := runKong(t, cmd, []string{"s1", "  ", "Sheet1!A1"}, ctx, flags)
		if err == nil || !strings.Contains(err.Error(), "empty source range") {
			t.Fatalf("expected empty source error, got %v", err)
		}
	})

	t.Run("empty dest range", func(t *testing.T) {
		cmd := &SheetsCopyPasteCmd{}
		err := runKong(t, cmd, []string{"s1", "Sheet1!A1", "  "}, ctx, flags)
		if err == nil || !strings.Contains(err.Error(), "empty dest range") {
			t.Fatalf("expected empty dest error, got %v", err)
		}
	})
}
