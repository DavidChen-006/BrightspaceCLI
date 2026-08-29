package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"google.golang.org/api/sheets/v4"
)

func TestSheetsTableCreateCmd(t *testing.T) {
	var gotReq sheets.BatchUpdateSpreadsheetRequest
	var gotBody string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/sheets/v4")
		path = strings.TrimPrefix(path, "/v4")
		switch {
		case strings.HasPrefix(path, "/spreadsheets/s1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "s1",
				"sheets": []map[string]any{
					{"properties": map[string]any{"sheetId": 42, "title": "Sheet1"}},
				},
			})
		case strings.Contains(path, "/spreadsheets/s1:batchUpdate") && r.Method == http.MethodPost:
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Fatalf("read batchUpdate: %v", err)
			}
			gotBody = string(body)
			if err := json.Unmarshal(body, &gotReq); err != nil {
				t.Fatalf("decode batchUpdate: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"replies": []map[string]any{
					{
						"addTable": map[string]any{
							"table": map[string]any{
								"tableId": "tbl1",
								"name":    "Tasks",
								"range": map[string]any{
									"sheetId":          42,
									"startRowIndex":    0,
									"endRowIndex":      4,
									"startColumnIndex": 0,
									"endColumnIndex":   3,
								},
								"columnProperties": []map[string]any{
									{"columnIndex": 0, "columnName": "Task", "columnType": "TEXT"},
									{"columnIndex": 1, "columnName": "Amount", "columnType": "DOUBLE"},
									{"columnIndex": 2, "columnName": "Done", "columnType": "BOOLEAN"},
								},
							},
						},
					},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ctx, output := newSheetsTableTestContext(t, srv)

	cmd := &SheetsTableCreateCmd{}
	if err := runKong(t, cmd, []string{
		"s1",
		"Sheet1!A1:C4",
		"--name", "Tasks",
		"--columns-json", `[{"columnName":"Task"},{"columnName":"Amount","columnType":"DOUBLE"},{"columnName":"Done","columnType":"BOOLEAN"}]`,
	}, ctx, &RootFlags{Account: "a@b.com"}); err != nil {
		t.Fatalf("create table: %v", err)
	}
	out := output.String()

	if len(gotReq.Requests) != 1 || gotReq.Requests[0].AddTable == nil || gotReq.Requests[0].AddTable.Table == nil {
		t.Fatalf("expected addTable request, got %#v", gotReq.Requests)
	}
	table := gotReq.Requests[0].AddTable.Table
	if table.Name != "Tasks" {
		t.Fatalf("table name = %q", table.Name)
	}
	if table.Range == nil || table.Range.SheetId != 42 || table.Range.EndRowIndex != 4 || table.Range.EndColumnIndex != 3 {
		t.Fatalf("range = %#v", table.Range)
	}
	if len(table.ColumnProperties) != 3 {
		t.Fatalf("columns = %#v", table.ColumnProperties)
	}
	if table.ColumnProperties[0].ColumnType != "TEXT" {
		t.Fatalf("default column type = %q", table.ColumnProperties[0].ColumnType)
	}
	if table.ColumnProperties[1].ColumnType != "DOUBLE" || table.ColumnProperties[2].ColumnType != "BOOLEAN" {
		t.Fatalf("column types = %#v", table.ColumnProperties)
	}
	if !strings.Contains(gotBody, `"columnIndex":0`) {
		t.Fatalf("expected zero columnIndex to be sent, body: %s", gotBody)
	}
	if !strings.Contains(out, `"tableId": "tbl1"`) {
		t.Fatalf("missing JSON table id: %s", out)
	}
}

func TestSheetsTableColumnTypeAliasesFailFast(t *testing.T) {
	tests := map[string]string{
		"NUMBER":     "use DOUBLE",
		"CHECKBOX":   "use BOOLEAN",
		"RATING":     "use RATINGS_CHIP",
		"SMART_CHIP": "use FILES_CHIP",
	}
	for input, want := range tests {
		t.Run(input, func(t *testing.T) {
			_, err := parseSheetsTableColumnsJSON(`[{"columnName":"Value","columnType":"`+input+`"}]`, strings.NewReader(""))
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error = %q, want %q", err.Error(), want)
			}
		})
	}
}

func TestSheetsTableColumnsJSONValidationIsUsage(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "invalid json", input: "nope", want: "invalid columns JSON"},
		{name: "multiple values", input: `[] []`, want: "multiple JSON values"},
		{name: "empty columns", input: `[]`, want: "provide at least one table column"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseSheetsTableColumnsJSON(tt.input, strings.NewReader(""))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected %q error, got %v", tt.want, err)
			}
			if got := ExitCode(err); got != 2 {
				t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
			}
		})
	}
}

func TestSheetsTableListGetDelete(t *testing.T) {
	var deletedID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/sheets/v4")
		path = strings.TrimPrefix(path, "/v4")
		switch {
		case strings.HasPrefix(path, "/spreadsheets/s1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "s1",
				"sheets": []map[string]any{
					{
						"properties": map[string]any{"sheetId": 42, "title": "Sheet1"},
						"tables": []map[string]any{
							{
								"tableId": "tbl1",
								"name":    "Tasks",
								"range": map[string]any{
									"sheetId":          42,
									"startRowIndex":    0,
									"endRowIndex":      4,
									"startColumnIndex": 0,
									"endColumnIndex":   3,
								},
								"columnProperties": []map[string]any{
									{"columnIndex": 0, "columnName": "Task", "columnType": "TEXT"},
								},
							},
						},
					},
				},
			})
		case strings.Contains(path, "/spreadsheets/s1:batchUpdate") && r.Method == http.MethodPost:
			var req sheets.BatchUpdateSpreadsheetRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode batchUpdate: %v", err)
			}
			if len(req.Requests) != 1 || req.Requests[0].DeleteTable == nil {
				t.Fatalf("expected deleteTable request, got %#v", req.Requests)
			}
			deletedID = req.Requests[0].DeleteTable.TableId
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ctx, output := newSheetsTableTestContext(t, srv)

	if err := (&SheetsTableListCmd{SpreadsheetID: "s1"}).Run(ctx, &RootFlags{Account: "a@b.com"}); err != nil {
		t.Fatalf("list tables: %v", err)
	}
	listOut := output.String()
	if !strings.Contains(listOut, `"a1": "Sheet1!A1:C4"`) {
		t.Fatalf("missing A1 output: %s", listOut)
	}

	output.Reset()
	if err := (&SheetsTableGetCmd{SpreadsheetID: "s1", TableID: "Tasks"}).Run(ctx, &RootFlags{Account: "a@b.com"}); err != nil {
		t.Fatalf("get table: %v", err)
	}
	getOut := output.String()
	if !strings.Contains(getOut, `"tableId": "tbl1"`) {
		t.Fatalf("missing table output: %s", getOut)
	}

	output.Reset()
	if err := (&SheetsTableDeleteCmd{SpreadsheetID: "s1", TableID: "tbl1", DiscardData: true}).Run(ctx, &RootFlags{Account: "a@b.com", Force: true}); err != nil {
		t.Fatalf("delete table: %v", err)
	}
	deleteOut := output.String()
	if deletedID != "tbl1" {
		t.Fatalf("deleted table id = %q", deletedID)
	}
	if !strings.Contains(deleteOut, `"tableId": "tbl1"`) {
		t.Fatalf("missing delete output: %s", deleteOut)
	}
}

func TestSheetsTableDeleteRequiresDiscardData(t *testing.T) {
	err := (&SheetsTableDeleteCmd{
		SpreadsheetID: "s1",
		TableID:       "tbl1",
	}).Run(newCmdJSONContext(t), &RootFlags{Force: true})
	if err == nil {
		t.Fatal("expected discard-data error")
	}
	if ExitCode(err) != 2 {
		t.Fatalf("ExitCode = %d, want 2", ExitCode(err))
	}
	if !strings.Contains(err.Error(), "--discard-data") || !strings.Contains(err.Error(), "deletes every cell") {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestSheetsTableDeleteDryRunDisclosesDataDeletion(t *testing.T) {
	output := &bytes.Buffer{}
	ctx := newCmdRuntimeJSONOutputContext(t, output, io.Discard)
	err := (&SheetsTableDeleteCmd{
		SpreadsheetID: "s1",
		TableID:       "tbl1",
	}).Run(ctx, &RootFlags{DryRun: true})
	if ExitCode(err) != 0 {
		t.Fatalf("expected dry-run exit, got %v", err)
	}
	out := output.String()

	var payload struct {
		Op      string         `json:"op"`
		Request map[string]any `json:"request"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("decode dry-run output: %v", err)
	}
	if payload.Op != "sheets.table.delete" {
		t.Fatalf("op = %q", payload.Op)
	}
	if payload.Request["discard_data"] != false || payload.Request["deletes_table_contents"] != true {
		t.Fatalf("request = %#v", payload.Request)
	}
}

func TestSheetsTableAppendCmd(t *testing.T) {
	var gotRange string
	var gotInsert string
	var gotInput string
	var gotValues sheets.ValueRange

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/sheets/v4")
		path = strings.TrimPrefix(path, "/v4")
		switch {
		case strings.HasPrefix(path, "/spreadsheets/s1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "s1",
				"sheets": []map[string]any{
					{
						"properties": map[string]any{"sheetId": 42, "title": "Sheet1"},
						"tables": []map[string]any{
							{
								"tableId": "tbl1",
								"name":    "Tasks",
								"range": map[string]any{
									"sheetId":          42,
									"startRowIndex":    0,
									"endRowIndex":      4,
									"startColumnIndex": 0,
									"endColumnIndex":   3,
								},
								"columnProperties": []map[string]any{
									{"columnIndex": 0, "columnName": "Task", "columnType": "TEXT"},
									{"columnIndex": 1, "columnName": "Amount", "columnType": "DOUBLE"},
									{"columnIndex": 2, "columnName": "Done", "columnType": "BOOLEAN"},
								},
							},
						},
					},
				},
			})
		case strings.Contains(path, "/spreadsheets/s1/values/") && strings.Contains(path, ":append") && r.Method == http.MethodPost:
			gotRange = strings.TrimSuffix(strings.TrimPrefix(path, "/spreadsheets/s1/values/"), ":append")
			gotInsert = r.URL.Query().Get("insertDataOption")
			gotInput = r.URL.Query().Get("valueInputOption")
			if err := json.NewDecoder(r.Body).Decode(&gotValues); err != nil {
				t.Fatalf("decode append: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"updates": map[string]any{
					"updatedRange":   "Sheet1!A4:C4",
					"updatedRows":    1,
					"updatedColumns": 3,
					"updatedCells":   3,
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ctx, output := newSheetsTableTestContext(t, srv)

	cmd := &SheetsTableAppendCmd{}
	if err := runKong(t, cmd, []string{
		"s1",
		"Tasks",
		"--values-json", `[["Write docs",2,true]]`,
	}, ctx, &RootFlags{Account: "a@b.com"}); err != nil {
		t.Fatalf("append table: %v", err)
	}
	out := output.String()

	if gotRange != "Sheet1!A1:C4" {
		t.Fatalf("append range = %q", gotRange)
	}
	if gotInsert != "INSERT_ROWS" {
		t.Fatalf("insertDataOption = %q", gotInsert)
	}
	if gotInput != sheetsDefaultValueInputOption {
		t.Fatalf("valueInputOption = %q", gotInput)
	}
	if len(gotValues.Values) != 1 || len(gotValues.Values[0]) != 3 {
		t.Fatalf("values = %#v", gotValues.Values)
	}
	if !strings.Contains(out, `"tableId": "tbl1"`) || !strings.Contains(out, `"updatedRange": "Sheet1!A4:C4"`) {
		t.Fatalf("missing append output: %s", out)
	}
}

func TestSheetsTableAppendRejectsTooWideRows(t *testing.T) {
	table := sheetsTableItem{
		Name: "Tasks",
		Columns: []sheetsTableColumnItem{
			{ColumnIndex: 0, ColumnName: "Task"},
			{ColumnIndex: 1, ColumnName: "Done"},
		},
	}
	err := validateSheetsTableAppendWidth(table, [][]interface{}{{"a", "b", "c"}})
	if err == nil {
		t.Fatal("expected width error")
	}
	if !strings.Contains(err.Error(), "has 3 cells") {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestSheetsTableAppendValueValidationIsUsage(t *testing.T) {
	tests := []struct {
		name       string
		valuesJSON string
		values     []string
		want       string
	}{
		{
			name: "missing values",
			want: "provide values",
		},
		{
			name:       "invalid json",
			valuesJSON: "nope",
			want:       "invalid JSON values",
		},
		{
			name:       "empty json rows",
			valuesJSON: "[]",
			want:       "provide at least one row",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseSheetsAppendValues(tt.valuesJSON, tt.values, strings.NewReader(""))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected %q error, got %v", tt.want, err)
			}
			if got := ExitCode(err); got != 2 {
				t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
			}
		})
	}
}

func TestSheetsTableClearCmdClearsDataRowsOnly(t *testing.T) {
	var gotClearRange string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/sheets/v4")
		path = strings.TrimPrefix(path, "/v4")
		switch {
		case strings.HasPrefix(path, "/spreadsheets/s1") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "s1",
				"sheets": []map[string]any{
					{
						"properties": map[string]any{"sheetId": 42, "title": "Sheet1"},
						"tables": []map[string]any{
							{
								"tableId": "tbl1",
								"name":    "Tasks",
								"range": map[string]any{
									"sheetId":          42,
									"startRowIndex":    0,
									"endRowIndex":      4,
									"startColumnIndex": 0,
									"endColumnIndex":   3,
								},
							},
						},
					},
				},
			})
		case strings.Contains(path, "/spreadsheets/s1/values/") && strings.Contains(path, ":clear") && r.Method == http.MethodPost:
			encodedRange := strings.TrimSuffix(strings.TrimPrefix(path, "/spreadsheets/s1/values/"), ":clear")
			decodedRange, err := url.PathUnescape(encodedRange)
			if err != nil {
				t.Fatalf("decode clear range: %v", err)
			}
			gotClearRange = decodedRange
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"clearedRange": decodedRange})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ctx, output := newSheetsTableTestContext(t, srv)

	if err := (&SheetsTableClearCmd{SpreadsheetID: "s1", TableID: "tbl1"}).Run(ctx, &RootFlags{Account: "a@b.com"}); err == nil {
		t.Fatal("expected --force error")
	} else if !strings.Contains(err.Error(), "requires --force") {
		t.Fatalf("error = %q", err.Error())
	}
	if gotClearRange != "" {
		t.Fatalf("clear ran without --force: %q", gotClearRange)
	}

	output.Reset()
	cmd := &SheetsTableClearCmd{}
	if err := runKong(t, cmd, []string{"s1", "tbl1"}, ctx, &RootFlags{Account: "a@b.com", Force: true}); err != nil {
		t.Fatalf("clear table: %v", err)
	}
	out := output.String()

	if gotClearRange != "Sheet1!A2:C4" {
		t.Fatalf("clear range = %q", gotClearRange)
	}
	if !strings.Contains(out, `"clearedRange": "Sheet1!A2:C4"`) || !strings.Contains(out, `"tableId": "tbl1"`) {
		t.Fatalf("missing clear output: %s", out)
	}
}

func TestSheetsTableDataRangeSkipsFooter(t *testing.T) {
	table := &sheets.Table{
		Range: &sheets.GridRange{
			SheetId:          42,
			StartRowIndex:    0,
			EndRowIndex:      5,
			StartColumnIndex: 0,
			EndColumnIndex:   3,
		},
		RowsProperties: &sheets.TableRowsProperties{
			FooterColorStyle: &sheets.ColorStyle{
				RgbColor: &sheets.Color{Red: 1},
			},
		},
	}
	got, ok := sheetsTableDataRangeA1("Sheet1", table)
	if !ok {
		t.Fatal("expected data range")
	}
	if got != "Sheet1!A2:C4" {
		t.Fatalf("data range = %q", got)
	}
}

func TestSheetsTableDataRangeRejectsHeaderOnly(t *testing.T) {
	table := &sheets.Table{
		Range: &sheets.GridRange{
			SheetId:          42,
			StartRowIndex:    0,
			EndRowIndex:      1,
			StartColumnIndex: 0,
			EndColumnIndex:   3,
		},
	}
	if got, ok := sheetsTableDataRangeA1("Sheet1", table); ok || got != "" {
		t.Fatalf("data range = %q, %v; want empty false", got, ok)
	}
}

func newSheetsTableTestContext(t *testing.T, srv *httptest.Server) (context.Context, *bytes.Buffer) {
	t.Helper()
	svc := newSheetsServiceFromServer(t, srv)
	output := &bytes.Buffer{}
	ctx := withSheetsTestService(newCmdRuntimeJSONOutputContext(t, output, io.Discard), svc)
	return ctx, output
}
