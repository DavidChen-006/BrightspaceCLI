package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"google.golang.org/api/sheets/v4"
)

func linksHandler() http.Handler {
	return sheetsAnnotationsHandler([][]map[string]any{
		{{"formattedValue": "Google", "hyperlink": "https://google.com"}, {"formattedValue": "Age"}},
		{{"formattedValue": "GitHub", "hyperlink": "https://github.com"}, {"formattedValue": "30"}},
		{{"formattedValue": "Bob"}, {"formattedValue": "Docs", "hyperlink": "https://docs.google.com"}},
	})
}

func newSheetsLinksTestContext(t *testing.T, handler http.Handler, jsonOutput bool) (context.Context, *bytes.Buffer, *bytes.Buffer) {
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

func TestSheetsLinksCmd_JSON(t *testing.T) {
	assertSheetsAnnotationsJSON(t, &SheetsLinksCmd{}, linksHandler(), newSheetsLinksTestContext, "links", "link", "https://google.com", "Google")
}

func TestSheetsLinksCmd_Text(t *testing.T) {
	ctx, output, _ := newSheetsLinksTestContext(t, linksHandler(), false)
	flags := &RootFlags{Account: "a@b.com"}
	if err := runKong(t, &SheetsLinksCmd{}, []string{"s1", "Sheet1!A1:B3"}, ctx, flags); err != nil {
		t.Fatalf("links: %v", err)
	}
	out := output.String()

	if !strings.Contains(out, "https://google.com") {
		t.Errorf("expected 'https://google.com' in output: %q", out)
	}
	if !strings.Contains(out, "https://docs.google.com") {
		t.Errorf("expected 'https://docs.google.com' in output: %q", out)
	}
	if !strings.Contains(out, "A1") {
		t.Errorf("expected table header in output: %q", out)
	}
}

func TestSheetsLinksCmd_OffsetRange_JSON(t *testing.T) {
	assertSheetsOffsetAnnotations(t, &SheetsLinksCmd{}, linksHandler(), newSheetsLinksTestContext, "links")
}

func TestSheetsLinksCmd_NoLinks(t *testing.T) {
	assertSheetsNoAnnotations(t, &SheetsLinksCmd{}, []string{"s1", "Sheet1!A1"}, newSheetsLinksTestContext, "No links found")
}

func TestSheetsLinksCmd_RichTextRunsAndCellLevelLinks(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sheets": []map[string]any{
				{
					"properties": map[string]any{
						"title": "Sheet1",
					},
					"data": []map[string]any{
						{
							"startRow":    2,
							"startColumn": 2,
							"rowData": []map[string]any{
								{
									"values": []map[string]any{
										{
											"formattedValue": "Rich links",
											"userEnteredFormat": map[string]any{
												"textFormat": map[string]any{
													"link": map[string]any{"uri": "https://cell.example"},
												},
											},
											"textFormatRuns": []map[string]any{
												{"startIndex": 0, "format": map[string]any{"link": map[string]any{"uri": "https://cell.example"}}},
												{"startIndex": 4, "format": map[string]any{"link": map[string]any{"uri": "https://run1.example"}}},
												{"startIndex": 8, "format": map[string]any{"link": map[string]any{"uri": " https://run2.example "}}},
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
	})

	ctx, output, _ := newSheetsLinksTestContext(t, handler, true)
	flags := &RootFlags{Account: "a@b.com"}
	if err := runKong(t, &SheetsLinksCmd{}, []string{"s1", "Sheet1!C3"}, ctx, flags); err != nil {
		t.Fatalf("links: %v", err)
	}
	out := output.String()

	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("unmarshal: %v (output: %q)", err, out)
	}

	linksAny, ok := result["links"].([]any)
	if !ok {
		t.Fatalf("expected links array, got %T", result["links"])
	}
	if len(linksAny) != 3 {
		t.Fatalf("expected 3 deduped links, got %d", len(linksAny))
	}

	got := make([]string, 0, len(linksAny))
	for _, entry := range linksAny {
		row := entry.(map[string]any)
		if row["a1"] != "Sheet1!C3" {
			t.Fatalf("unexpected a1: %v", row["a1"])
		}
		got = append(got, row["link"].(string))
	}

	want := []string{"https://cell.example", "https://run1.example", "https://run2.example"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected links: got %v want %v", got, want)
	}
}

func TestExtractCellLinks(t *testing.T) {
	cell := &sheets.CellData{
		Hyperlink: " https://a.example ",
		UserEnteredFormat: &sheets.CellFormat{
			TextFormat: &sheets.TextFormat{
				Link: &sheets.Link{Uri: "https://a.example"},
			},
		},
		TextFormatRuns: []*sheets.TextFormatRun{
			{Format: &sheets.TextFormat{Link: &sheets.Link{Uri: "https://b.example"}}},
			{Format: &sheets.TextFormat{Link: &sheets.Link{Uri: "https://a.example"}}},
			nil,
			{Format: nil},
			{Format: &sheets.TextFormat{Link: &sheets.Link{Uri: "   "}}},
		},
	}

	got := extractCellLinks(cell)
	want := []string{"https://a.example", "https://b.example"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected links: got %v want %v", got, want)
	}
}
