package cmd

import (
	"strings"
	"testing"

	searchconsoleapi "google.golang.org/api/searchconsole/v1"
)

func TestSearchConsoleQueryCmd_Plan(t *testing.T) {
	t.Parallel()

	cmd := &SearchConsoleQueryCmd{
		SiteURL:    " sc-domain:example.com ",
		From:       "2026-02-01",
		To:         "2026-02-28",
		Dimensions: "query,page",
		Type:       "web",
		Max:        250,
		Offset:     10,
	}
	plan, err := cmd.plan(strings.NewReader(""))
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.SiteURL != "sc-domain:example.com" {
		t.Fatalf("unexpected site URL: %q", plan.SiteURL)
	}
	if plan.Request == nil || plan.Request.RowLimit != 250 || plan.Request.StartRow != 10 {
		t.Fatalf("unexpected request: %#v", plan.Request)
	}
	if plan.queryType() != "WEB" {
		t.Fatalf("unexpected query type: %q", plan.queryType())
	}
}

func TestSearchConsoleQueryCmd_PlanValidatesSiteURL(t *testing.T) {
	t.Parallel()

	_, err := (&SearchConsoleQueryCmd{}).plan(strings.NewReader(""))
	if err == nil || !strings.Contains(err.Error(), "empty siteUrl") {
		t.Fatalf("plan() error = %v, want empty siteUrl", err)
	}
}

func TestSearchConsoleQueryPlan_QueryTypeFallback(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name    string
		request *searchconsoleapi.SearchAnalyticsQueryRequest
		want    string
	}{
		{name: "nil"},
		{
			name:    "search type",
			request: &searchconsoleapi.SearchAnalyticsQueryRequest{SearchType: "IMAGE"},
			want:    "IMAGE",
		},
		{
			name:    "type precedence",
			request: &searchconsoleapi.SearchAnalyticsQueryRequest{Type: "WEB", SearchType: "IMAGE"},
			want:    "WEB",
		},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			plan := searchConsoleQueryPlan{Request: testCase.request}
			if got := plan.queryType(); got != testCase.want {
				t.Fatalf("queryType() = %q, want %q", got, testCase.want)
			}
		})
	}
}
