package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/sheets/v4"
)

func TestSheetsNumberFormatCmd(t *testing.T) {
	var gotRepeat *sheets.RepeatCellRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/sheets/v4"), "/v4")
		switch {
		case strings.HasPrefix(path, "/spreadsheets/s1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sheets": []map[string]any{
					{"properties": map[string]any{"sheetId": 7, "title": "Sheet1"}},
				},
			})
		case strings.Contains(path, "/spreadsheets/s1:batchUpdate") && r.Method == http.MethodPost:
			var req sheets.BatchUpdateSpreadsheetRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode batchUpdate: %v", err)
			}
			if len(req.Requests) != 1 || req.Requests[0].RepeatCell == nil {
				t.Fatalf("expected repeatCell request, got %#v", req.Requests)
			}
			gotRepeat = req.Requests[0].RepeatCell
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	svc := newSheetsServiceFromServer(t, srv)

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSheetsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	gotRepeat = nil
	cmd := &SheetsNumberFormatCmd{}
	runErr := runKong(t, cmd, []string{"s1", "Sheet1!A1:B2", "--type", "CURRENCY", "--pattern", "$#,##0.00"}, ctx, flags)
	if runErr != nil {
		t.Fatalf("number-format: %v", runErr)
	}
	if gotRepeat == nil || gotRepeat.Cell == nil || gotRepeat.Cell.UserEnteredFormat == nil || gotRepeat.Cell.UserEnteredFormat.NumberFormat == nil {
		t.Fatalf("missing number format payload: %#v", gotRepeat)
	}
	if gotRepeat.Fields != "userEnteredFormat.numberFormat" {
		t.Fatalf("unexpected fields: %s", gotRepeat.Fields)
	}
	if gotRepeat.Cell.UserEnteredFormat.NumberFormat.Type != "CURRENCY" {
		t.Fatalf("unexpected type: %#v", gotRepeat.Cell.UserEnteredFormat.NumberFormat)
	}
	if gotRepeat.Cell.UserEnteredFormat.NumberFormat.Pattern != "$#,##0.00" {
		t.Fatalf("unexpected pattern: %#v", gotRepeat.Cell.UserEnteredFormat.NumberFormat)
	}

	gotRepeat = nil
	cmd = &SheetsNumberFormatCmd{}
	runErr = runKong(t, cmd, []string{"s1", "Sheet1!A1:B2", "--type", "BOGUS"}, ctx, flags)
	if runErr == nil || !strings.Contains(runErr.Error(), "invalid --type") {
		t.Fatalf("expected invalid type error, got %v", runErr)
	}
	if got := ExitCode(runErr); got != 2 {
		t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, runErr)
	}
	if gotRepeat != nil {
		t.Fatal("did not expect an API request")
	}
}
