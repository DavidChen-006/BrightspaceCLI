package cmd

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/sheets/v4"
)

func newSheetsTestServer(t *testing.T, batchUpdateCapture *sheets.BatchUpdateSpreadsheetRequest, sheetsCatalog []map[string]any) (*sheets.Service, func()) {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/sheets/v4")
		path = strings.TrimPrefix(path, "/v4")

		switch {
		case strings.HasPrefix(path, "/spreadsheets/s1") && !strings.Contains(path, ":batchUpdate") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "s1",
				"sheets":        sheetsCatalog,
			})
		case strings.Contains(path, "/spreadsheets/s1:batchUpdate") && r.Method == http.MethodPost:
			if err := json.NewDecoder(r.Body).Decode(batchUpdateCapture); err != nil {
				t.Fatalf("decode batchUpdate: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	return newSheetsServiceFromServer(t, srv), func() {}
}

func newSheetsCmdContext(t *testing.T, svc *sheets.Service) context.Context {
	t.Helper()
	return withSheetsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
}

func TestSheetsReorderTabCmd_ResolutionAndIndex(t *testing.T) {
	tests := []struct {
		name      string
		catalog   []map[string]any
		tab       string
		to        string
		wantID    int64
		wantIndex int64
	}{
		{
			name: "resolves by name", tab: "Third", to: "0", wantID: 33, wantIndex: 0,
			catalog: []map[string]any{
				{"properties": map[string]any{"sheetId": 11, "title": "First", "index": 0}},
				{"properties": map[string]any{"sheetId": 22, "title": "Second", "index": 1}},
				{"properties": map[string]any{"sheetId": 33, "title": "Third", "index": 2}},
			},
		},
		{
			name: "accepts numeric sheet ID", tab: "99", to: "2", wantID: 99, wantIndex: 3,
			catalog: []map[string]any{
				{"properties": map[string]any{"sheetId": 99, "title": "Only", "index": 0}},
				{"properties": map[string]any{"sheetId": 100, "title": "Next", "index": 1}},
				{"properties": map[string]any{"sheetId": 101, "title": "Last", "index": 2}},
			},
		},
		{
			name: "adjusts rightward API index", tab: "First", to: "1", wantID: 11, wantIndex: 2,
			catalog: []map[string]any{
				{"properties": map[string]any{"sheetId": 11, "title": "First", "index": 0}},
				{"properties": map[string]any{"sheetId": 22, "title": "Second", "index": 1}},
				{"properties": map[string]any{"sheetId": 33, "title": "Third", "index": 2}},
			},
		},
		{
			name: "prefers numeric title", tab: "2024", to: "2", wantID: 11, wantIndex: 3,
			catalog: []map[string]any{
				{"properties": map[string]any{"sheetId": 11, "title": "2024", "index": 0}},
				{"properties": map[string]any{"sheetId": 2024, "title": "Other", "index": 1}},
				{"properties": map[string]any{"sheetId": 33, "title": "Last", "index": 2}},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var captured sheets.BatchUpdateSpreadsheetRequest
			svc, cleanup := newSheetsTestServer(t, &captured, tc.catalog)
			defer cleanup()
			if err := runKong(t, &SheetsReorderTabCmd{}, []string{"s1", "--tab", tc.tab, "--to", tc.to}, newSheetsCmdContext(t, svc), &RootFlags{Account: "a@b.com"}); err != nil {
				t.Fatalf("reorder-tab: %v", err)
			}
			if len(captured.Requests) != 1 || captured.Requests[0].UpdateSheetProperties == nil || captured.Requests[0].UpdateSheetProperties.Properties == nil {
				t.Fatalf("unexpected requests: %#v", captured.Requests)
			}
			request := captured.Requests[0].UpdateSheetProperties
			if request.Properties.SheetId != tc.wantID || request.Properties.Index != tc.wantIndex || request.Fields != "index" {
				t.Fatalf("request = %#v, want sheetId=%d index=%d fields=index", request, tc.wantID, tc.wantIndex)
			}
		})
	}
}

func TestSheetsReorderTabCmd_ZeroValuesAreSerialized(t *testing.T) {
	tests := []struct {
		name    string
		catalog []map[string]any
		tab     string
		to      string
		want    []string
	}{
		{
			name: "index zero", tab: "Second", to: "0", want: []string{`"index":0`, `"fields":"index"`},
			catalog: []map[string]any{
				{"properties": map[string]any{"sheetId": 11, "title": "First", "index": 0}},
				{"properties": map[string]any{"sheetId": 22, "title": "Second", "index": 1}},
			},
		},
		{
			name: "sheet ID zero", tab: "First", to: "1", want: []string{`"sheetId":0`, `"index":2`},
			catalog: []map[string]any{
				{"properties": map[string]any{"sheetId": 0, "title": "First", "index": 0}},
				{"properties": map[string]any{"sheetId": 22, "title": "Second", "index": 1}},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var rawBody []byte
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				path := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/sheets/v4"), "/v4")
				switch {
				case strings.HasPrefix(path, "/spreadsheets/s1") && !strings.Contains(path, ":batchUpdate") && r.Method == http.MethodGet:
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(map[string]any{"spreadsheetId": "s1", "sheets": tc.catalog})
				case strings.Contains(path, "/spreadsheets/s1:batchUpdate") && r.Method == http.MethodPost:
					var err error
					rawBody, err = io.ReadAll(r.Body)
					if err != nil {
						t.Fatalf("read body: %v", err)
					}
					_, _ = w.Write([]byte(`{}`))
				default:
					http.NotFound(w, r)
				}
			}))
			t.Cleanup(srv.Close)
			if err := runKong(t, &SheetsReorderTabCmd{}, []string{"s1", "--tab", tc.tab, "--to", tc.to}, newSheetsCmdContext(t, newSheetsServiceFromServer(t, srv)), &RootFlags{Account: "a@b.com"}); err != nil {
				t.Fatalf("reorder-tab: %v", err)
			}
			for _, want := range tc.want {
				if !strings.Contains(string(rawBody), want) {
					t.Fatalf("body %s does not contain %s", rawBody, want)
				}
			}
		})
	}
}

func TestSheetsReorderTabCmd_UnknownTabName(t *testing.T) {
	var captured sheets.BatchUpdateSpreadsheetRequest
	svc, cleanup := newSheetsTestServer(t, &captured, []map[string]any{
		{"properties": map[string]any{"sheetId": 1, "title": "Sheet1", "index": 0}},
	})
	defer cleanup()

	flags := &RootFlags{Account: "a@b.com"}
	ctx := newSheetsCmdContext(t, svc)

	err := runKong(t, &SheetsReorderTabCmd{}, []string{"s1", "--tab", "Nope", "--to", "1"}, ctx, flags)
	if err == nil || !strings.Contains(err.Error(), `unknown tab "Nope"`) {
		t.Fatalf("expected unknown-tab error, got %v", err)
	}
}

func TestSheetsReorderTabCmd_UnknownNumericSheetID(t *testing.T) {
	var captured sheets.BatchUpdateSpreadsheetRequest
	svc, cleanup := newSheetsTestServer(t, &captured, []map[string]any{
		{"properties": map[string]any{"sheetId": 1, "title": "Sheet1", "index": 0}},
	})
	defer cleanup()

	flags := &RootFlags{Account: "a@b.com"}
	ctx := newSheetsCmdContext(t, svc)

	err := runKong(t, &SheetsReorderTabCmd{}, []string{"s1", "--tab", "99", "--to", "0"}, ctx, flags)
	if err == nil || !strings.Contains(err.Error(), "unknown sheetId 99") {
		t.Fatalf("expected unknown-sheetId error, got %v", err)
	}
}

func TestSheetsReorderTabCmd_IndexOutOfRangeRejected(t *testing.T) {
	var captured sheets.BatchUpdateSpreadsheetRequest
	svc, cleanup := newSheetsTestServer(t, &captured, []map[string]any{
		{"properties": map[string]any{"sheetId": 1, "title": "Sheet1", "index": 0}},
		{"properties": map[string]any{"sheetId": 2, "title": "Sheet2", "index": 1}},
	})
	defer cleanup()

	flags := &RootFlags{Account: "a@b.com"}
	ctx := newSheetsCmdContext(t, svc)

	err := runKong(t, &SheetsReorderTabCmd{}, []string{"s1", "--tab", "Sheet1", "--to", "2"}, ctx, flags)
	if err == nil || !strings.Contains(err.Error(), "--to must be between 0 and 1") {
		t.Fatalf("expected range validation error, got %v", err)
	}
}

func TestSheetsReorderTabCmd_NegativeIndexRejected(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com"}
	ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)
	err := runKong(t, &SheetsReorderTabCmd{}, []string{"s1", "--tab", "x", "--to=-1"}, ctx, flags)
	if err == nil || !strings.Contains(err.Error(), "--to must be >= 0") {
		t.Fatalf("expected --to validation error, got %v", err)
	}
}
