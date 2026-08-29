package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSheetsMetadataCmd_TextAndJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/v4/spreadsheets/id1") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId":  "id1",
				"spreadsheetUrl": "https://docs.google.com/spreadsheets/d/id1",
				"properties": map[string]any{
					"title":    "Budget",
					"locale":   "en_US",
					"timeZone": "UTC",
				},
				"sheets": []map[string]any{
					{"properties": map[string]any{"sheetId": 1, "title": "Sheet1", "gridProperties": map[string]any{"rowCount": 10, "columnCount": 5}}},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	svc := newSheetsServiceFromServer(t, srv)

	flags := &RootFlags{Account: "a@b.com"}

	var outBuf bytes.Buffer
	ctx := withSheetsTestService(newCmdRuntimeOutputContext(t, &outBuf, io.Discard), svc)

	cmd := &SheetsMetadataCmd{}
	if execErr := runKong(t, cmd, []string{"id1"}, ctx, flags); execErr != nil {
		t.Fatalf("execute: %v", execErr)
	}
	text := outBuf.String()
	if !strings.Contains(text, "ID\tid1") || !strings.Contains(text, "Sheets:") {
		t.Fatalf("unexpected text: %q", text)
	}

	var jsonOut bytes.Buffer
	ctx2 := withSheetsTestService(newCmdRuntimeJSONOutputContext(t, &jsonOut, io.Discard), svc)
	cmd2 := &SheetsMetadataCmd{}
	if execErr := runKong(t, cmd2, []string{"id1"}, ctx2, flags); execErr != nil {
		t.Fatalf("execute: %v", execErr)
	}

	var parsed struct {
		SpreadsheetID string `json:"spreadsheetId"`
		Title         string `json:"title"`
		Sheets        []any  `json:"sheets"`
	}
	if err := json.Unmarshal(jsonOut.Bytes(), &parsed); err != nil {
		t.Fatalf("json parse: %v", err)
	}
	if parsed.SpreadsheetID != "id1" || parsed.Title != "Budget" || len(parsed.Sheets) != 1 {
		t.Fatalf("unexpected json: %#v", parsed)
	}
}
