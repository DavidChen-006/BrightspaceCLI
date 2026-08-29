package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// chartRecorder captures batchUpdate requests.
type chartRecorder struct {
	requests []map[string]any
}

func chartHandler(recorder *chartRecorder) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/sheets/v4")
		path = strings.TrimPrefix(path, "/v4")

		// Metadata GET for chart list and sheet ID resolution.
		if strings.HasPrefix(path, "/spreadsheets/empty") && r.Method == http.MethodGet && !strings.Contains(path, "batchUpdate") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "empty",
				"sheets": []map[string]any{
					{
						"properties": map[string]any{
							"sheetId": 123,
							"title":   "Sheet1",
						},
					},
				},
			})
			return
		}

		if strings.HasPrefix(path, "/spreadsheets/s1") && r.Method == http.MethodGet && !strings.Contains(path, "batchUpdate") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "s1",
				"sheets": []map[string]any{
					{
						"properties": map[string]any{
							"sheetId": 123,
							"title":   "Sheet1",
						},
						"charts": []map[string]any{
							{
								"chartId": 100,
								"spec": map[string]any{
									"title": "Revenue",
									"basicChart": map[string]any{
										"chartType": "COLUMN",
									},
								},
							},
							{
								"chartId": 200,
								"spec": map[string]any{
									"title": "Expenses",
									"basicChart": map[string]any{
										"chartType": "LINE",
									},
								},
							},
						},
					},
				},
			})
			return
		}

		if strings.HasPrefix(path, "/spreadsheets/zero") && r.Method == http.MethodGet && !strings.Contains(path, "batchUpdate") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "zero",
				"sheets": []map[string]any{
					{
						"properties": map[string]any{
							"sheetId": 0,
							"title":   "Sheet1",
						},
						"charts": []map[string]any{
							{
								"chartId": 100,
								"spec": map[string]any{
									"title": "Revenue",
									"basicChart": map[string]any{
										"chartType": "COLUMN",
									},
								},
							},
						},
					},
				},
			})
			return
		}

		// BatchUpdate POST.
		if (strings.HasPrefix(path, "/spreadsheets/s1:batchUpdate") ||
			strings.HasPrefix(path, "/spreadsheets/zero:batchUpdate")) && r.Method == http.MethodPost {
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}

			requests, ok := body["requests"].([]any)
			if !ok || len(requests) == 0 {
				http.Error(w, "missing requests", http.StatusBadRequest)
				return
			}

			recorder.requests = recorder.requests[:0]
			for _, req := range requests {
				reqMap, ok := req.(map[string]any)
				if !ok {
					http.Error(w, "expected request object", http.StatusBadRequest)
					return
				}
				recorder.requests = append(recorder.requests, reqMap)
			}

			// Build reply for addChart.
			replies := make([]map[string]any, len(requests))
			for i, req := range requests {
				reqMap, _ := req.(map[string]any)
				if _, ok := reqMap["addChart"]; ok {
					replies[i] = map[string]any{
						"addChart": map[string]any{
							"chart": map[string]any{
								"chartId": 999,
							},
						},
					}
				} else {
					replies[i] = map[string]any{}
				}
			}

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"spreadsheetId": "s1",
				"replies":       replies,
			})
			return
		}

		http.NotFound(w, r)
	})
}

func newChartTestContext(t *testing.T, recorder *chartRecorder) (context.Context, *RootFlags, func()) {
	t.Helper()
	ctx, flags, _, cleanup := newChartOutputTestContext(t, recorder, false)
	return ctx, flags, cleanup
}

func newChartOutputTestContext(t *testing.T, recorder *chartRecorder, jsonOutput bool) (context.Context, *RootFlags, *bytes.Buffer, func()) {
	t.Helper()

	srv := httptest.NewServer(chartHandler(recorder))
	svc := newSheetsServiceFromServer(t, srv)
	output := &bytes.Buffer{}
	var ctx context.Context
	if jsonOutput {
		ctx = newCmdRuntimeJSONOutputContext(t, output, io.Discard)
	} else {
		ctx = newCmdRuntimeOutputContext(t, output, io.Discard)
	}
	ctx = withSheetsTestService(ctx, svc)
	flags := &RootFlags{Account: "a@b.com"}
	return ctx, flags, output, srv.Close
}

func TestSheetsChartList_JSON(t *testing.T) {
	recorder := &chartRecorder{}
	ctx, flags, output, cleanup := newChartOutputTestContext(t, recorder, true)
	defer cleanup()

	if err := runKong(t, &SheetsChartListCmd{}, []string{"s1"}, ctx, flags); err != nil {
		t.Fatalf("chart list: %v", err)
	}
	out := output.String()

	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("unmarshal: %v (output: %q)", err, out)
	}

	charts, ok := result["charts"].([]any)
	if !ok {
		t.Fatalf("expected charts array, got %T", result["charts"])
	}
	if len(charts) != 2 {
		t.Fatalf("expected 2 charts, got %d", len(charts))
	}

	first := charts[0].(map[string]any)
	if first["chartId"] != float64(100) {
		t.Errorf("expected chartId 100, got %v", first["chartId"])
	}
	if first["title"] != "Revenue" {
		t.Errorf("expected title Revenue, got %v", first["title"])
	}
	if first["type"] != "COLUMN" {
		t.Errorf("expected type COLUMN, got %v", first["type"])
	}
}

func TestSheetsChartList_Text(t *testing.T) {
	recorder := &chartRecorder{}
	ctx, flags, _, cleanup := newChartOutputTestContext(t, recorder, false)
	defer cleanup()

	if err := runKong(t, &SheetsChartListCmd{}, []string{"s1"}, ctx, flags); err != nil {
		t.Fatalf("chart list: %v", err)
	}
}

func TestSheetsChartList_JSONEmptyArray(t *testing.T) {
	recorder := &chartRecorder{}
	ctx, flags, output, cleanup := newChartOutputTestContext(t, recorder, true)
	defer cleanup()

	if err := runKong(t, &SheetsChartListCmd{}, []string{"empty"}, ctx, flags); err != nil {
		t.Fatalf("chart list: %v", err)
	}
	out := output.String()

	var result struct {
		Charts []any `json:"charts"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("unmarshal: %v (output: %q)", err, out)
	}
	if result.Charts == nil {
		t.Fatalf("charts = nil, want empty array")
	}
	if len(result.Charts) != 0 {
		t.Fatalf("charts len = %d, want 0", len(result.Charts))
	}
}

func TestSheetsChartGet_JSON(t *testing.T) {
	recorder := &chartRecorder{}
	ctx, flags, output, cleanup := newChartOutputTestContext(t, recorder, true)
	defer cleanup()

	if err := runKong(t, &SheetsChartGetCmd{}, []string{"s1", "100"}, ctx, flags); err != nil {
		t.Fatalf("chart get: %v", err)
	}
	out := output.String()

	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("unmarshal: %v (output: %q)", err, out)
	}

	if result["chartId"] != float64(100) {
		t.Errorf("expected chartId 100, got %v", result["chartId"])
	}

	spec, ok := result["spec"].(map[string]any)
	if !ok {
		t.Fatalf("expected spec in output, got %v", result)
	}
	if spec["title"] != "Revenue" {
		t.Errorf("expected title Revenue, got %v", spec["title"])
	}
}

func TestSheetsChartGet_NotFound(t *testing.T) {
	recorder := &chartRecorder{}
	ctx, flags, _, cleanup := newChartOutputTestContext(t, recorder, false)
	defer cleanup()

	err := runKong(t, &SheetsChartGetCmd{}, []string{"s1", "999999"}, ctx, flags)
	if err == nil {
		t.Fatal("expected error for unknown chart")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("unexpected error: %v", err)
	}
}
