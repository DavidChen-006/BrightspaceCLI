package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func sheetsCommandsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/sheets/v4"), "/v4")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(path, "/spreadsheets/s1/values/") && strings.Contains(path, ":append") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"updates": map[string]any{"updatedCells": 1}})
		case strings.Contains(path, "/spreadsheets/s1/values/") && strings.Contains(path, ":clear") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"clearedRange": "Sheet1!A1"})
		case strings.Contains(path, "/spreadsheets/s1/values/") && r.Method == http.MethodPut:
			_ = json.NewEncoder(w).Encode(map[string]any{"updatedCells": 2})
		case strings.Contains(path, "/spreadsheets/s1/values/") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"range": "Sheet1!A1:B2", "values": [][]any{{"a", "b"}}})
		case strings.HasPrefix(path, "/spreadsheets/s1") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "s1", "spreadsheetUrl": "http://example.com/s1",
				"properties": map[string]any{"title": "Sheet", "locale": "en", "timeZone": "UTC"},
				"sheets": []map[string]any{{"properties": map[string]any{
					"sheetId": 1, "title": "Sheet1", "gridProperties": map[string]any{"rowCount": 10, "columnCount": 5},
				}}},
			})
		case path == "/spreadsheets" && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "s2", "spreadsheetUrl": "http://example.com/s2",
				"properties": map[string]any{"title": "New Sheet"},
			})
		default:
			http.NotFound(w, r)
		}
	})
}

func TestSheetsCommands(t *testing.T) {
	for _, mode := range []struct {
		name       string
		outputFlag string
		createArgs []string
		wantText   bool
	}{
		{name: "json", outputFlag: "--json", createArgs: []string{"--sheets", "Sheet1,Sheet2"}},
		{name: "text", outputFlag: "--plain", wantText: true},
	} {
		t.Run(mode.name, func(t *testing.T) {
			srv := httptest.NewServer(sheetsCommandsHandler())
			t.Cleanup(srv.Close)
			svc := newSheetsServiceFromServer(t, srv)
			prefix := []string{mode.outputFlag, "--account", "a@b.com", "sheets"}
			commands := []struct {
				name string
				args []string
			}{
				{name: "get", args: []string{"get", "s1", "Sheet1!A1:B2"}},
				{name: "update", args: []string{"update", "s1", "Sheet1!A1", "--values-json", `[["a","b"]]`}},
				{name: "append", args: []string{"append", "s1", "Sheet1!A1", "--values-json", `[["a"]]`}},
				{name: "clear", args: []string{"clear", "s1", "Sheet1!A1"}},
				{name: "metadata", args: []string{"metadata", "s1"}},
				{name: "create", args: append([]string{"create", "New Sheet"}, mode.createArgs...)},
			}
			var out strings.Builder
			for _, command := range commands {
				result := executeWithSheetsTestService(t, append(prefix, command.args...), svc)
				if result.err != nil {
					t.Fatalf("%s: %v", command.name, result.err)
				}
				out.WriteString(result.stdout)
			}
			if mode.wantText && (!strings.Contains(out.String(), "Sheet1") || !strings.Contains(out.String(), "Created spreadsheet")) {
				t.Fatalf("unexpected output: %q", out.String())
			}
		})
	}
}
