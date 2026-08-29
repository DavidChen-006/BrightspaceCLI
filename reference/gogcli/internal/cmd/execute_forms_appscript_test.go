package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	formsapi "google.golang.org/api/forms/v1"
	"google.golang.org/api/option"
)

func TestExecute_FormsGet_Text(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(strings.Contains(r.URL.Path, "/forms/form123") && r.Method == http.MethodGet) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"formId":       "form123",
			"responderUri": "https://docs.google.com/forms/d/e/resp",
			"info": map[string]any{
				"title":       "Survey",
				"description": "Weekly check-in",
			},
		})
	}))
	defer srv.Close()

	svc, err := formsapi.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	result := executeWithFormsTestService(t, []string{"--account", "a@b.com", "forms", "get", "form123"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout
	if !strings.Contains(out, "id\tform123") || !strings.Contains(out, "title\tSurvey") || !strings.Contains(out, "edit_url\thttps://docs.google.com/forms/d/form123/edit") {
		t.Fatalf("unexpected out=%q", out)
	}
}

func TestExecute_FormsResponsesList_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(strings.Contains(r.URL.Path, "/forms/form123/responses") && r.Method == http.MethodGet) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"responses": []map[string]any{
				{
					"responseId":        "r1",
					"lastSubmittedTime": "2026-02-14T00:00:00Z",
					"respondentEmail":   "user@example.com",
				},
			},
			"nextPageToken": "next123",
		})
	}))
	defer srv.Close()

	svc, err := formsapi.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	result := executeWithFormsTestService(t, []string{"--json", "--account", "a@b.com", "forms", "responses", "list", "form123", "--max", "1"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		FormID    string `json:"form_id"`
		Responses []struct {
			ResponseID string `json:"responseId"`
		} `json:"responses"`
		NextPageToken string `json:"nextPageToken"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if parsed.FormID != "form123" || len(parsed.Responses) != 1 || parsed.Responses[0].ResponseID != "r1" || parsed.NextPageToken != "next123" {
		t.Fatalf("unexpected payload: %#v", parsed)
	}
}

func TestExecute_FormsResponsesList_JSONEmptyArray(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(strings.Contains(r.URL.Path, "/forms/form123/responses") && r.Method == http.MethodGet) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{})
	}))
	defer srv.Close()

	svc, err := formsapi.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	result := executeWithFormsTestService(t, []string{"--json", "--account", "a@b.com", "forms", "responses", "list", "form123", "--max", "1"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		FormID    string            `json:"form_id"`
		Responses []json.RawMessage `json:"responses"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if parsed.FormID != "form123" {
		t.Fatalf("form_id = %q", parsed.FormID)
	}
	if parsed.Responses == nil {
		t.Fatalf("responses must be an empty array, got nil: %s", out)
	}
	if len(parsed.Responses) != 0 {
		t.Fatalf("responses len = %d, want 0", len(parsed.Responses))
	}
}

func TestExecute_FormsResponsesList_RejectsNonPositiveMax(t *testing.T) {
	result := executeWithFormsTestServiceFactory(t,
		[]string{"--account", "a@b.com", "forms", "responses", "list", "form123", "--max", "0"},
		unexpectedFormsTestService(t, "expected validation to fail before creating forms service"),
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "--max must be > 0") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_FormsCreate_DryRun_JSON(t *testing.T) {
	result := executeWithFormsTestServiceFactory(t, []string{
		"--json",
		"--dry-run",
		"--account", "a@b.com",
		"forms", "create",
		"--title", "Weekly Check-in",
		"--description", "Friday async update",
	}, unexpectedFormsTestService(t, "dry-run should not create forms service"))
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		DryRun  bool   `json:"dry_run"`
		Op      string `json:"op"`
		Request struct {
			Title       string `json:"title"`
			Description string `json:"description"`
		} `json:"request"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !parsed.DryRun || parsed.Op != "forms.create" {
		t.Fatalf("unexpected dry-run payload: %#v", parsed)
	}
	if parsed.Request.Title != "Weekly Check-in" || parsed.Request.Description != "Friday async update" {
		t.Fatalf("unexpected request payload: %#v", parsed.Request)
	}
}

func TestExecute_FormsCreate_DescriptionBatchUpdate(t *testing.T) {
	var sawCreate bool
	var sawBatchUpdate bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/forms") && r.Method == http.MethodPost && !strings.Contains(r.URL.Path, ":batchUpdate"):
			sawCreate = true
			var req formsapi.Form
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode create request: %v", err)
			}
			if req.Info == nil || req.Info.Title != "Weekly Check-in" {
				t.Fatalf("unexpected create request: %#v", req.Info)
			}
			if req.Info.Description != "" {
				t.Fatalf("create request must not send description: %#v", req.Info)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"formId": "form123",
				"info": map[string]any{
					"title": "Weekly Check-in",
				},
			})
			return
		case strings.Contains(r.URL.Path, "/forms/form123:batchUpdate") && r.Method == http.MethodPost:
			sawBatchUpdate = true
			var req formsapi.BatchUpdateFormRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode batch request: %v", err)
			}
			if len(req.Requests) != 1 || req.Requests[0].UpdateFormInfo == nil {
				t.Fatalf("unexpected batch request: %#v", req.Requests)
			}
			update := req.Requests[0].UpdateFormInfo
			if update.UpdateMask != "description" || update.Info == nil || update.Info.Description != "Friday async update" {
				t.Fatalf("unexpected update request: %#v", update)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{})
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	defer srv.Close()

	svc, err := formsapi.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	result := executeWithFormsTestService(t, []string{
		"--json",
		"--account", "a@b.com",
		"forms", "create",
		"--title", "Weekly Check-in",
		"--description", "Friday async update",
	}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout
	if !sawCreate || !sawBatchUpdate {
		t.Fatalf("expected create and batchUpdate; sawCreate=%v sawBatchUpdate=%v", sawCreate, sawBatchUpdate)
	}
	if !strings.Contains(out, `"description": "Friday async update"`) {
		t.Fatalf("missing description in output: %s", out)
	}
}

func TestExecute_AppScriptRun_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(strings.Contains(r.URL.Path, "/scripts/script123:run") && r.Method == http.MethodPost) {
			http.NotFound(w, r)
			return
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req["function"] != "myFunc" {
			t.Fatalf("unexpected function: %#v", req["function"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"done": true,
			"response": map[string]any{
				"result": map[string]any{
					"ok": true,
				},
			},
		})
	}))
	defer srv.Close()

	svc := newAppScriptTestService(t, srv)
	result := executeWithAppScriptTestService(t, []string{
		"--json", "--account", "a@b.com",
		"appscript", "run", "script123", "myFunc",
		"--params", "[\"x\"]",
	}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed map[string]any
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	op, ok := parsed["operation"].(map[string]any)
	if !ok {
		t.Fatalf("missing operation: %#v", parsed)
	}
	if done, _ := op["done"].(bool); !done {
		t.Fatalf("expected done=true: %#v", op)
	}
}

func TestExecute_AppScriptCreate_DryRun_Text(t *testing.T) {
	result := executeWithAppScriptTestServiceFactory(t, []string{
		"--dry-run",
		"--account", "a@b.com",
		"appscript", "create",
		"--title", "Automation Helpers",
		"--parent-id", "drive123",
	}, unexpectedAppScriptTestService(t, "dry-run should not create appscript service"))
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout
	if !strings.Contains(out, "Dry run: would appscript.create") ||
		!strings.Contains(out, `"title": "Automation Helpers"`) ||
		!strings.Contains(out, `"parent_id": "drive123"`) {
		t.Fatalf("unexpected dry-run out=%q", out)
	}
}

func TestExecute_AppScriptRun_RejectsNonArrayParams(t *testing.T) {
	result := executeWithAppScriptTestServiceFactory(
		t,
		[]string{"--account", "a@b.com", "appscript", "run", "script123", "myFunc", "--params", `{"x":1}`},
		unexpectedAppScriptTestService(t, "expected params validation to fail before creating appscript service"),
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "invalid --params JSON array") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_AppScriptRun_TextErrorDetails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(strings.Contains(r.URL.Path, "/scripts/script123:run") && r.Method == http.MethodPost) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"done": true,
			"error": map[string]any{
				"code":    3,
				"message": "Script execution failed",
				"details": []map[string]any{
					{
						"@type":        "type.googleapis.com/google.apps.script.type.ExecutionError",
						"errorType":    "TypeError",
						"errorMessage": "boom",
					},
				},
			},
		})
	}))
	defer srv.Close()

	svc := newAppScriptTestService(t, srv)
	result := executeWithAppScriptTestService(t, []string{
		"--account", "a@b.com",
		"appscript", "run", "script123", "myFunc",
	}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout
	if !strings.Contains(out, "done\ttrue") ||
		!strings.Contains(out, "error_code\t3") ||
		!strings.Contains(out, "error\tScript execution failed") ||
		!strings.Contains(out, "error_type\tTypeError") ||
		!strings.Contains(out, "error_message\tboom") {
		t.Fatalf("unexpected out=%q", out)
	}
}
