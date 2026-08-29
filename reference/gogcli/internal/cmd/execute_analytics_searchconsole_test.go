package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	analyticsadminapi "google.golang.org/api/analyticsadmin/v1beta"
	analyticsdataapi "google.golang.org/api/analyticsdata/v1beta"
	searchconsoleapi "google.golang.org/api/searchconsole/v1"
)

func TestExecute_AnalyticsAccounts_JSON(t *testing.T) {
	svc := newAnalyticsAdminTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/v1beta/accountSummaries")) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"accountSummaries": []map[string]any{
				{
					"account":     "accounts/123",
					"displayName": "Demo Account",
					"propertySummaries": []map[string]any{
						{"property": "properties/999", "displayName": "Main Property"},
					},
				},
			},
			"nextPageToken": "next123",
		})
	}))
	result := executeWithAnalyticsAdminTestService(t, []string{"--json", "--account", "a@b.com", "analytics", "accounts", "--max", "1"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}

	var parsed struct {
		AccountSummaries []struct {
			Account string `json:"account"`
		} `json:"account_summaries"`
		NextPageToken string `json:"nextPageToken"`
	}
	if err := json.Unmarshal([]byte(result.stdout), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(parsed.AccountSummaries) != 1 || parsed.AccountSummaries[0].Account != "accounts/123" || parsed.NextPageToken != "next123" {
		t.Fatalf("unexpected payload: %#v", parsed)
	}
}

func TestExecute_AnalyticsAccounts_Text(t *testing.T) {
	svc := newAnalyticsAdminTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/v1beta/accountSummaries")) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"accountSummaries": []map[string]any{
				{
					"account":     "accounts/123",
					"displayName": "Demo Account",
					"propertySummaries": []map[string]any{
						{"property": "properties/999", "displayName": "Main Property"},
					},
				},
			},
			"nextPageToken": "next123",
		})
	}))
	result := executeWithAnalyticsAdminTestService(t, []string{"--account", "a@b.com", "analytics", "accounts", "--max", "1"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	if !strings.Contains(result.stdout, "ACCOUNT") ||
		!strings.Contains(result.stdout, "DISPLAY_NAME") ||
		!strings.Contains(result.stdout, "PROPERTIES") ||
		!strings.Contains(result.stdout, "123") ||
		!strings.Contains(result.stdout, "Demo Account") ||
		!strings.Contains(result.stdout, "1") {
		t.Fatalf("unexpected out=%q", result.stdout)
	}
}

func TestExecute_AnalyticsAccounts_AllPages_JSON(t *testing.T) {
	page1Calls := 0
	page2Calls := 0
	svc := newAnalyticsAdminTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/v1beta/accountSummaries")) {
			http.NotFound(w, r)
			return
		}
		if got := r.URL.Query().Get("pageSize"); got != "1" {
			t.Fatalf("expected pageSize=1, got %q", got)
		}

		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Query().Get("pageToken") {
		case "":
			page1Calls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accountSummaries": []map[string]any{
					{"account": "accounts/111", "displayName": "One"},
				},
				"nextPageToken": "p2",
			})
		case "p2":
			page2Calls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accountSummaries": []map[string]any{
					{"account": "accounts/222", "displayName": "Two"},
				},
				"nextPageToken": "",
			})
		default:
			t.Fatalf("unexpected pageToken=%q", r.URL.Query().Get("pageToken"))
		}
	}))
	result := executeWithAnalyticsAdminTestService(t, []string{
		"--json",
		"--account", "a@b.com",
		"analytics", "accounts",
		"--all",
		"--max", "1",
	}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}

	var parsed struct {
		AccountSummaries []struct {
			Account string `json:"account"`
		} `json:"account_summaries"`
		NextPageToken string `json:"nextPageToken"`
	}
	if err := json.Unmarshal([]byte(result.stdout), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(parsed.AccountSummaries) != 2 ||
		parsed.AccountSummaries[0].Account != "accounts/111" ||
		parsed.AccountSummaries[1].Account != "accounts/222" ||
		parsed.NextPageToken != "" {
		t.Fatalf("unexpected payload: %#v", parsed)
	}
	if page1Calls != 1 || page2Calls != 1 {
		t.Fatalf("unexpected page calls: page1=%d page2=%d", page1Calls, page2Calls)
	}
}

func TestExecute_AnalyticsAccounts_ServiceError(t *testing.T) {
	result := executeWithAnalyticsAdminTestServiceFactory(
		t,
		[]string{"--account", "a@b.com", "analytics", "accounts"},
		func(context.Context, string) (*analyticsadminapi.Service, error) {
			return nil, errors.New("analytics admin service down")
		},
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "analytics admin service down") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_AnalyticsReport_Text(t *testing.T) {
	svc := newAnalyticsDataTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/v1beta/properties/123:runReport")) {
			http.NotFound(w, r)
			return
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req["limit"] != "10" {
			t.Fatalf("unexpected report limit payload: %#v", req)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"dimensionHeaders": []map[string]any{{"name": "date"}, {"name": "country"}},
			"metricHeaders":    []map[string]any{{"name": "activeUsers"}, {"name": "sessions"}},
			"rowCount":         1,
			"rows": []map[string]any{
				{
					"dimensionValues": []map[string]any{{"value": "2026-02-01"}, {"value": "US"}},
					"metricValues":    []map[string]any{{"value": "42"}, {"value": "11"}},
				},
			},
		})
	}))
	result := executeWithAnalyticsDataTestService(t, []string{
		"--account", "a@b.com",
		"analytics", "report", "123",
		"--from", "2026-02-01",
		"--to", "2026-02-01",
		"--dimensions", "date,country",
		"--metrics", "activeUsers,sessions",
		"--max", "10",
	}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	if !strings.Contains(result.stdout, "DATE") ||
		!strings.Contains(result.stdout, "COUNTRY") ||
		!strings.Contains(result.stdout, "ACTIVEUSERS") ||
		!strings.Contains(result.stdout, "SESSIONS") ||
		!strings.Contains(result.stdout, "2026-02-01") ||
		!strings.Contains(result.stdout, "US") ||
		!strings.Contains(result.stdout, "42") ||
		!strings.Contains(result.stdout, "11") {
		t.Fatalf("unexpected out=%q", result.stdout)
	}
}

func TestExecute_AnalyticsReport_JSON(t *testing.T) {
	svc := newAnalyticsDataTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/v1beta/properties/123:runReport")) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"dimensionHeaders": []map[string]any{{"name": "date"}},
			"metricHeaders":    []map[string]any{{"name": "activeUsers"}},
			"rowCount":         1,
			"rows": []map[string]any{
				{
					"dimensionValues": []map[string]any{{"value": "2026-02-01"}},
					"metricValues":    []map[string]any{{"value": "42"}},
				},
			},
		})
	}))
	result := executeWithAnalyticsDataTestService(t, []string{
		"--json",
		"--account", "a@b.com",
		"analytics", "report", "123",
		"--from", "2026-02-01",
		"--to", "2026-02-01",
		"--dimensions", "date",
		"--metrics", "activeUsers",
	}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}

	var parsed struct {
		Property string `json:"property"`
		From     string `json:"from"`
		To       string `json:"to"`
		RowCount int64  `json:"row_count"`
		Rows     []struct {
			DimensionValues []struct {
				Value string `json:"value"`
			} `json:"dimensionValues"`
			MetricValues []struct {
				Value string `json:"value"`
			} `json:"metricValues"`
		} `json:"rows"`
	}
	if err := json.Unmarshal([]byte(result.stdout), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if parsed.Property != "properties/123" || parsed.From != "2026-02-01" || parsed.To != "2026-02-01" || parsed.RowCount != 1 || len(parsed.Rows) != 1 {
		t.Fatalf("unexpected payload: %#v", parsed)
	}
}

func TestExecute_AnalyticsReport_FailEmpty_JSON(t *testing.T) {
	svc := newAnalyticsDataTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/v1beta/properties/123:runReport")) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"dimensionHeaders": []map[string]any{{"name": "date"}},
			"metricHeaders":    []map[string]any{{"name": "activeUsers"}},
			"rowCount":         0,
			"rows":             []map[string]any{},
		})
	}))
	result := executeWithAnalyticsDataTestService(t, []string{
		"--json",
		"--account", "a@b.com",
		"analytics", "report", "123",
		"--from", "2026-02-01",
		"--to", "2026-02-01",
		"--dimensions", "date",
		"--metrics", "activeUsers",
		"--fail-empty",
	}, svc)
	if result.err == nil {
		t.Fatalf("expected error")
	}
	if got := ExitCode(result.err); got != emptyResultsExitCode {
		t.Fatalf("expected exit code %d, got %d", emptyResultsExitCode, got)
	}

	var parsed struct {
		Property string           `json:"property"`
		RowCount int64            `json:"row_count"`
		Rows     []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal([]byte(result.stdout), &parsed); err != nil {
		t.Fatalf("unmarshal: %v\nout=%q", err, result.stdout)
	}
	if parsed.Property != "properties/123" || parsed.RowCount != 0 || len(parsed.Rows) != 0 {
		t.Fatalf("unexpected payload: %#v", parsed)
	}
}

func TestExecute_AnalyticsReport_ServiceError(t *testing.T) {
	result := executeWithAnalyticsDataTestServiceFactory(
		t,
		[]string{
			"--account", "a@b.com",
			"analytics", "report", "123",
			"--from", "2026-02-01",
			"--to", "2026-02-01",
			"--metrics", "activeUsers",
		},
		func(context.Context, string) (*analyticsdataapi.Service, error) {
			return nil, errors.New("analytics data service down")
		},
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "analytics data service down") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_AnalyticsReport_ValidatesMetricsBeforeServiceCall(t *testing.T) {
	result := executeWithAnalyticsDataTestServiceFactory(
		t,
		[]string{
			"--account", "a@b.com",
			"analytics", "report", "123",
			"--from", "2026-02-01",
			"--to", "2026-02-01",
			"--metrics", "",
		},
		unexpectedAnalyticsDataTestService(t, "expected validation to fail before creating analytics data service"),
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "empty --metrics") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_SearchConsoleSites_Text(t *testing.T) {
	svc := newSearchConsoleTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/webmasters/v3/sites")) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"siteEntry": []map[string]any{
				{"siteUrl": "sc-domain:example.com", "permissionLevel": "SITE_OWNER"},
			},
		})
	}))
	result := executeWithSearchConsoleTestService(t, []string{"--account", "a@b.com", "searchconsole", "sites"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	if !strings.Contains(result.stdout, "SITE") || !strings.Contains(result.stdout, "PERMISSION") || !strings.Contains(result.stdout, "sc-domain:example.com") || !strings.Contains(result.stdout, "SITE_OWNER") {
		t.Fatalf("unexpected out=%q", result.stdout)
	}
}

func TestExecute_SearchConsoleSites_JSON(t *testing.T) {
	svc := newSearchConsoleTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/webmasters/v3/sites")) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"siteEntry": []map[string]any{
				{"siteUrl": "sc-domain:example.com", "permissionLevel": "SITE_OWNER"},
			},
		})
	}))
	result := executeWithSearchConsoleTestService(t, []string{"--json", "--account", "a@b.com", "searchconsole", "sites"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}

	var parsed struct {
		Sites []struct {
			SiteURL         string `json:"siteUrl"`
			PermissionLevel string `json:"permissionLevel"`
		} `json:"sites"`
	}
	if err := json.Unmarshal([]byte(result.stdout), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(parsed.Sites) != 1 || parsed.Sites[0].SiteURL != "sc-domain:example.com" || parsed.Sites[0].PermissionLevel != "SITE_OWNER" {
		t.Fatalf("unexpected payload: %#v", parsed)
	}
}

func TestExecute_SearchConsoleSites_ServiceError(t *testing.T) {
	result := executeWithSearchConsoleTestServiceFactory(
		t,
		[]string{"--account", "a@b.com", "searchconsole", "sites"},
		func(context.Context, string) (*searchconsoleapi.Service, error) {
			return nil, errors.New("search console service down")
		},
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "search console service down") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_SearchConsoleQuery_JSON(t *testing.T) {
	svc := newSearchConsoleTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/searchAnalytics/query")) {
			http.NotFound(w, r)
			return
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req["startDate"] != "2026-02-01" || req["endDate"] != "2026-02-07" || req["type"] != "WEB" {
			t.Fatalf("unexpected request payload: %#v", req)
		}
		dimensions, ok := req["dimensions"].([]any)
		if !ok || len(dimensions) != 2 || dimensions[0] != "QUERY" || dimensions[1] != "PAGE" {
			t.Fatalf("unexpected dimensions payload: %#v", req["dimensions"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"responseAggregationType": "AUTO",
			"rows": []map[string]any{
				{
					"keys":        []string{"gog cli", "https://example.com/docs"},
					"clicks":      12,
					"impressions": 300,
					"ctr":         0.04,
					"position":    7.3,
				},
			},
		})
	}))
	result := executeWithSearchConsoleTestService(t, []string{
		"--json",
		"--account", "a@b.com",
		"searchconsole", "query", "sc-domain:example.com",
		"--from", "2026-02-01",
		"--to", "2026-02-07",
		"--dimensions", "query,page",
		"--type", "web",
		"--max", "10",
	}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}

	var parsed struct {
		SiteURL string `json:"site_url"`
		Type    string `json:"type"`
		Rows    []struct {
			Keys []string `json:"keys"`
		} `json:"rows"`
	}
	if err := json.Unmarshal([]byte(result.stdout), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if parsed.SiteURL != "sc-domain:example.com" || parsed.Type != "WEB" || len(parsed.Rows) != 1 || len(parsed.Rows[0].Keys) != 2 {
		t.Fatalf("unexpected payload: %#v", parsed)
	}
}

func TestExecute_SearchConsoleQuery_Text(t *testing.T) {
	svc := newSearchConsoleTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !(r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/searchAnalytics/query")) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"responseAggregationType": "AUTO",
			"rows": []map[string]any{
				{
					"keys":        []string{"gog cli", "https://example.com/docs"},
					"clicks":      12,
					"impressions": 300,
					"ctr":         0.04,
					"position":    7.3,
				},
			},
		})
	}))
	result := executeWithSearchConsoleTestService(t, []string{
		"--account", "a@b.com",
		"searchconsole", "query", "sc-domain:example.com",
		"--from", "2026-02-01",
		"--to", "2026-02-07",
		"--dimensions", "query,page",
		"--type", "web",
		"--max", "10",
	}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	if !strings.Contains(result.stdout, "QUERY") ||
		!strings.Contains(result.stdout, "PAGE") ||
		!strings.Contains(result.stdout, "CLICKS") ||
		!strings.Contains(result.stdout, "IMPRESSIONS") ||
		!strings.Contains(result.stdout, "CTR") ||
		!strings.Contains(result.stdout, "POSITION") ||
		!strings.Contains(result.stdout, "gog cli") ||
		!strings.Contains(result.stdout, "https://example.com/docs") ||
		!strings.Contains(result.stdout, "12") ||
		!strings.Contains(result.stdout, "300") {
		t.Fatalf("unexpected out=%q", result.stdout)
	}
}

func TestExecute_SearchConsoleQuery_ServiceError(t *testing.T) {
	result := executeWithSearchConsoleTestServiceFactory(
		t,
		[]string{
			"--account", "a@b.com",
			"searchconsole", "query", "sc-domain:example.com",
			"--from", "2026-02-01",
			"--to", "2026-02-07",
		},
		func(context.Context, string) (*searchconsoleapi.Service, error) {
			return nil, errors.New("search console service down")
		},
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "search console service down") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_SearchConsoleQuery_ValidatesDateBeforeServiceCall(t *testing.T) {
	result := executeWithSearchConsoleTestServiceFactory(
		t,
		[]string{
			"--account", "a@b.com",
			"searchconsole", "query", "sc-domain:example.com",
			"--from", "2026/02/01",
			"--to", "2026-02-07",
		},
		unexpectedSearchConsoleTestService(t, "expected validation to fail before creating search console service"),
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "invalid --from") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}
