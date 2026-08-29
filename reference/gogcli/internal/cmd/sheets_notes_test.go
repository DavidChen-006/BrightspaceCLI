package cmd

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func notesHandler() http.Handler {
	return sheetsAnnotationsHandler([][]map[string]any{
		{{"formattedValue": "Name", "note": "Header note"}, {"formattedValue": "Age"}},
		{{"formattedValue": "Alice", "note": "First entry"}, {"formattedValue": "30"}},
		{{"formattedValue": "Bob"}, {"formattedValue": "25", "note": "Estimated"}},
	})
}

func newSheetsNotesTestContext(t *testing.T, handler http.Handler, jsonOutput bool) (context.Context, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	svc := newSheetsServiceFromServer(t, srv)
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	var ctx context.Context
	if jsonOutput {
		ctx = newCmdRuntimeJSONOutputContext(t, stdout, stderr)
	} else {
		ctx = newCmdRuntimeOutputContext(t, stdout, stderr)
	}
	return withSheetsTestService(ctx, svc), stdout, stderr
}

func TestSheetsNotesCmd_JSON(t *testing.T) {
	assertSheetsAnnotationsJSON(t, &SheetsNotesCmd{}, notesHandler(), newSheetsNotesTestContext, "notes", "note", "Header note", "Name")
}

func TestSheetsNotesCmd_Text(t *testing.T) {
	ctx, output, _ := newSheetsNotesTestContext(t, notesHandler(), false)
	flags := &RootFlags{Account: "a@b.com"}
	if err := runKong(t, &SheetsNotesCmd{}, []string{"s1", "Sheet1!A1:B3"}, ctx, flags); err != nil {
		t.Fatalf("notes: %v", err)
	}
	out := output.String()

	if !strings.Contains(out, "Header note") {
		t.Errorf("expected 'Header note' in output: %q", out)
	}
	if !strings.Contains(out, "Estimated") {
		t.Errorf("expected 'Estimated' in output: %q", out)
	}
	if !strings.Contains(out, "A1") {
		t.Errorf("expected table header in output: %q", out)
	}
}

func TestSheetsNotesCmd_OffsetRange_JSON(t *testing.T) {
	assertSheetsOffsetAnnotations(t, &SheetsNotesCmd{}, notesHandler(), newSheetsNotesTestContext, "notes")
}

func TestSheetsNotesCmd_NoNotes(t *testing.T) {
	assertSheetsNoAnnotations(t, &SheetsNotesCmd{}, []string{"s1", "Sheet1!A1"}, newSheetsNotesTestContext, "No notes found")
}
