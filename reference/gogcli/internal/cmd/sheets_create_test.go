package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/drive/v3"
)

func TestSheetsCreateCmd_ParentMoveSuccess(t *testing.T) {
	sheetsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.Contains(r.URL.Path, "/v4/spreadsheets") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"spreadsheetId":  "id2",
			"spreadsheetUrl": "https://example.test/sheets/id2",
			"properties":     map[string]any{"title": "Budget"},
		})
	}))
	defer sheetsSrv.Close()

	var sawGet bool
	var sawPatch bool
	driveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/files/id2") {
			http.NotFound(w, r)
			return
		}
		switch r.Method {
		case http.MethodGet:
			sawGet = true
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "id2",
				"parents": []string{"root"},
			})
		case http.MethodPatch:
			sawPatch = true
			if got := r.URL.Query().Get("addParents"); got != "folder123" {
				t.Fatalf("addParents=%q", got)
			}
			if got := r.URL.Query().Get("removeParents"); got != "root" {
				t.Fatalf("removeParents=%q", got)
			}
			if got := r.URL.Query().Get("supportsAllDrives"); got != "true" {
				t.Fatalf("supportsAllDrives=%q", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "id2",
				"parents": []string{"folder123"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer driveSrv.Close()

	t.Setenv("GOG_ACCOUNT", "a@b.com")

	sheetsSvc := newSheetsServiceFromServer(t, sheetsSrv)
	driveSvc := newGoogleTestServiceWithEndpoint(t, driveSrv.Client(), driveSrv.URL+"/", drive.NewService)

	result := executeWithSheetsAndDriveTestServices(t, []string{"--json", "sheets", "create", "Budget", "--parent", "folder123"}, sheetsSvc, driveSvc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(result.stdout), &payload); err != nil {
		t.Fatalf("json.Unmarshal: %v\nstdout=%q", err, result.stdout)
	}

	if !sawGet || !sawPatch {
		t.Fatalf("expected drive get+patch, sawGet=%v sawPatch=%v", sawGet, sawPatch)
	}
	if got := payload["parent"]; got != "folder123" {
		t.Fatalf("parent=%v", got)
	}
	if got := payload["movedToParent"]; got != true {
		t.Fatalf("movedToParent=%v", got)
	}
	if _, ok := payload["moveError"]; ok {
		t.Fatalf("unexpected moveError=%v", payload["moveError"])
	}
	if strings.TrimSpace(result.stderr) != "" {
		t.Fatalf("unexpected stderr=%q", result.stderr)
	}
}

func TestSheetsCreateCmd_ParentMoveFailureReportedInJSON(t *testing.T) {
	sheetsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.Contains(r.URL.Path, "/v4/spreadsheets") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"spreadsheetId":  "id2",
			"spreadsheetUrl": "https://example.test/sheets/id2",
			"properties":     map[string]any{"title": "Budget"},
		})
	}))
	defer sheetsSrv.Close()

	driveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/files/id2") {
			http.NotFound(w, r)
			return
		}
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      "id2",
				"parents": []string{"root"},
			})
		case http.MethodPatch:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{
					"code":    403,
					"message": "forbidden",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer driveSrv.Close()

	t.Setenv("GOG_ACCOUNT", "a@b.com")

	sheetsSvc := newSheetsServiceFromServer(t, sheetsSrv)
	driveSvc := newGoogleTestServiceWithEndpoint(t, driveSrv.Client(), driveSrv.URL+"/", drive.NewService)

	result := executeWithSheetsAndDriveTestServices(t, []string{"--json", "sheets", "create", "Budget", "--parent", "folder123"}, sheetsSvc, driveSvc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(result.stdout), &payload); err != nil {
		t.Fatalf("json.Unmarshal: %v\nstdout=%q", err, result.stdout)
	}

	if got := payload["parent"]; got != "folder123" {
		t.Fatalf("parent=%v", got)
	}
	if got := payload["movedToParent"]; got != false {
		t.Fatalf("movedToParent=%v", got)
	}
	moveError, _ := payload["moveError"].(string)
	if !strings.Contains(moveError, "forbidden") {
		t.Fatalf("moveError=%q", moveError)
	}
	if !strings.Contains(result.stderr, "failed to move spreadsheet to folder") {
		t.Fatalf("stderr=%q", result.stderr)
	}
	if !strings.Contains(result.stderr, "Spreadsheet created in Drive root") {
		t.Fatalf("stderr=%q", result.stderr)
	}
}
