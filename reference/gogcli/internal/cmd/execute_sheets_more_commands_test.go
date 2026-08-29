package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExecute_SheetsMoreCommands(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/v4/spreadsheets/id1/values/") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"range":  "Sheet1!A1:B1",
				"values": []any{[]any{"a", "b"}},
			})
			return
		case strings.Contains(path, "/v4/spreadsheets/id1/values/") && strings.Contains(path, ":clear") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"clearedRange": "Sheet1!A1:B1",
			})
			return
		case strings.Contains(path, "/v4/spreadsheets/id1/values/") && strings.Contains(path, ":append") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"updates": map[string]any{
					"updatedRange":   "Sheet1!A1:B1",
					"updatedRows":    1,
					"updatedColumns": 2,
					"updatedCells":   2,
				},
			})
			return
		case strings.Contains(path, "/v4/spreadsheets/id1/values/") && r.Method == http.MethodPut:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"updatedRange":   "Sheet1!A1:B1",
				"updatedRows":    1,
				"updatedColumns": 2,
				"updatedCells":   2,
			})
			return
		case strings.Contains(path, "/v4/spreadsheets/id1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "id1",
				"properties":    map[string]any{"title": "T"},
				"sheets": []map[string]any{
					{
						"properties": map[string]any{"sheetId": 0, "title": "Sheet1"},
						"data": []map[string]any{
							{
								"startRow":    0,
								"startColumn": 0,
								"rowData": []map[string]any{
									{
										"values": []map[string]any{
											{
												"formattedValue": "a",
												"userEnteredFormat": map[string]any{
													"textFormat": map[string]any{"bold": true},
												},
											},
										},
									},
								},
							},
						},
					},
				},
			})
			return
		case strings.Contains(path, "/v4/spreadsheets") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "id2",
				"properties":    map[string]any{"title": "New"},
			})
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	t.Setenv("GOG_ACCOUNT", "a@b.com")

	svc := newSheetsServiceFromServer(t, srv)
	run := func(args ...string) executeTestResult {
		return executeWithSheetsTestService(t, args, svc)
	}

	result := run("--plain", "sheets", "get", "id1", `Sheet1\\!A1:B1`)
	if result.err != nil {
		t.Fatalf("get: %v", result.err)
	}
	if result.stdout != "a\tb\n" {
		t.Fatalf("unexpected plain out=%q", result.stdout)
	}

	commands := []struct {
		name string
		args []string
	}{
		{"update", []string{"--json", "sheets", "update", "id1", "Sheet1!A1:B1", "a|b"}},
		{"update json", []string{"--json", "sheets", "update", "id1", "Sheet1!A1:B1", "--values-json", `[["a","b"]]`}},
		{"append", []string{"--json", "sheets", "append", "id1", "Sheet1!A1:B1", "a|b"}},
		{"append json", []string{"--json", "sheets", "append", "id1", "Sheet1!A1:B1", "--values-json", `[["a","b"]]`}},
		{"clear", []string{"--json", "sheets", "clear", "id1", "Sheet1!A1:B1"}},
		{"metadata", []string{"--json", "sheets", "metadata", "id1"}},
		{"read-format", []string{"--json", "sheets", "read-format", "id1", "Sheet1!A1:A1"}},
		{"create", []string{"--json", "sheets", "create", "New", "--sheets", "Income,Expenses"}},
	}
	for _, command := range commands {
		if result := run(command.args...); result.err != nil {
			t.Fatalf("%s: %v", command.name, result.err)
		}
	}
}
