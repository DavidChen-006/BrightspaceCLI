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

func readFormatHandler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/sheets/v4")
		path = strings.TrimPrefix(path, "/v4")
		if strings.HasPrefix(path, "/spreadsheets/s1") && r.Method == http.MethodGet {
			if r.URL.Query().Get("includeGridData") != "true" {
				http.Error(w, "expected includeGridData=true", http.StatusBadRequest)
				return
			}
			fields := r.URL.Query().Get("fields")

			values := []map[string]any{
				{
					"formattedValue": "Header",
					"userEnteredFormat": map[string]any{
						"textFormat": map[string]any{"bold": true},
					},
				},
				{
					"formattedValue": "No Format",
				},
			}
			if strings.Contains(fields, "effectiveFormat") {
				values[0] = map[string]any{
					"formattedValue": "Header",
					"effectiveFormat": map[string]any{
						"borders": map[string]any{
							"top": map[string]any{
								"style": "SOLID",
							},
						},
					},
				}
			}

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sheets": []map[string]any{
					{
						"properties": map[string]any{"title": "Sheet1"},
						"data": []map[string]any{
							{
								"startRow":    0,
								"startColumn": 0,
								"rowData": []map[string]any{
									{
										"values": values,
									},
								},
							},
						},
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	})
}

func TestSheetsReadFormatCmd_JSON(t *testing.T) {
	srv := httptest.NewServer(readFormatHandler(t))
	defer srv.Close()

	svc := newSheetsServiceFromServer(t, srv)

	flags := &RootFlags{Account: "a@b.com"}
	var out bytes.Buffer
	ctx := withSheetsTestService(newCmdRuntimeJSONOutputContext(t, &out, io.Discard), svc)
	if err := runKong(t, &SheetsReadFormatCmd{}, []string{"s1", "Sheet1!A1:B1"}, ctx, flags); err != nil {
		t.Fatalf("read-format: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal: %v (output: %q)", err, out.String())
	}
	if result["source"] != "userEnteredFormat" {
		t.Fatalf("expected userEnteredFormat source, got %v", result["source"])
	}

	formats, ok := result["formats"].([]any)
	if !ok {
		t.Fatalf("expected formats array, got %T", result["formats"])
	}
	if len(formats) != 1 {
		t.Fatalf("expected 1 formatted cell, got %d", len(formats))
	}

	first := formats[0].(map[string]any)
	if first["a1"] != "Sheet1!A1" {
		t.Fatalf("expected a1 Sheet1!A1, got %v", first["a1"])
	}
	formatMap := first["format"].(map[string]any)
	textFormat := formatMap["textFormat"].(map[string]any)
	if textFormat["bold"] != true {
		t.Fatalf("expected bold textFormat, got %#v", textFormat)
	}
}

func TestSheetsReadFormatCmd_Effective_JSON(t *testing.T) {
	srv := httptest.NewServer(readFormatHandler(t))
	defer srv.Close()

	svc := newSheetsServiceFromServer(t, srv)

	flags := &RootFlags{Account: "a@b.com"}
	var out bytes.Buffer
	ctx := withSheetsTestService(newCmdRuntimeJSONOutputContext(t, &out, io.Discard), svc)
	if err := runKong(t, &SheetsReadFormatCmd{}, []string{"s1", "Sheet1!A1:B1", "--effective"}, ctx, flags); err != nil {
		t.Fatalf("read-format effective: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal: %v (output: %q)", err, out.String())
	}
	if result["source"] != "effectiveFormat" {
		t.Fatalf("expected effectiveFormat source, got %v", result["source"])
	}

	formats := result["formats"].([]any)
	first := formats[0].(map[string]any)
	formatMap := first["format"].(map[string]any)
	borders := formatMap["borders"].(map[string]any)
	top := borders["top"].(map[string]any)
	if top["style"] != "SOLID" {
		t.Fatalf("expected SOLID top border, got %#v", top)
	}
}

func TestSheetsReadFormatCmd_Text(t *testing.T) {
	srv := httptest.NewServer(readFormatHandler(t))
	defer srv.Close()

	svc := newSheetsServiceFromServer(t, srv)

	flags := &RootFlags{Account: "a@b.com"}

	var out bytes.Buffer
	ctx := withSheetsTestService(newCmdRuntimeOutputContext(t, &out, io.Discard), svc)
	if err := runKong(t, &SheetsReadFormatCmd{}, []string{"s1", "Sheet1!A1:B1"}, ctx, flags); err != nil {
		t.Fatalf("read-format text: %v", err)
	}

	if !strings.Contains(out.String(), "A1") {
		t.Fatalf("expected header in output: %q", out.String())
	}
	if !strings.Contains(out.String(), "Sheet1!A1") {
		t.Fatalf("expected A1 in output: %q", out.String())
	}
	if !strings.Contains(out.String(), "\"bold\":true") {
		t.Fatalf("expected JSON format payload in output: %q", out.String())
	}
}
