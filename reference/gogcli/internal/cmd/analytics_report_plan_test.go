package cmd

import (
	"strings"
	"testing"
)

func TestNewAnalyticsReportPlan(t *testing.T) {
	t.Parallel()

	plan, err := newAnalyticsReportPlan(analyticsReportInput{
		Property:   " /123 ",
		From:       " 7daysAgo ",
		To:         " today ",
		Dimensions: "date, country",
		Metrics:    "activeUsers, sessions",
		Max:        25,
		Offset:     5,
	})
	if err != nil {
		t.Fatalf("newAnalyticsReportPlan: %v", err)
	}
	if plan.Property != "properties/123" || plan.From != "7daysAgo" || plan.To != "today" {
		t.Fatalf("unexpected normalized plan: %#v", plan)
	}
	if len(plan.Dimensions) != 2 || plan.Dimensions[0] != "date" || plan.Dimensions[1] != "country" {
		t.Fatalf("unexpected dimensions: %#v", plan.Dimensions)
	}
	if len(plan.Metrics) != 2 || plan.Metrics[0] != "activeUsers" || plan.Metrics[1] != "sessions" {
		t.Fatalf("unexpected metrics: %#v", plan.Metrics)
	}
	if plan.Request == nil || plan.Request.Limit != 25 || plan.Request.Offset != 5 {
		t.Fatalf("unexpected request: %#v", plan.Request)
	}
	if len(plan.Request.DateRanges) != 1 ||
		plan.Request.DateRanges[0].StartDate != "7daysAgo" ||
		plan.Request.DateRanges[0].EndDate != "today" {
		t.Fatalf("unexpected date ranges: %#v", plan.Request.DateRanges)
	}
	if len(plan.Request.Dimensions) != 2 ||
		plan.Request.Dimensions[0].Name != "date" ||
		plan.Request.Dimensions[1].Name != "country" {
		t.Fatalf("unexpected request dimensions: %#v", plan.Request.Dimensions)
	}
	if len(plan.Request.Metrics) != 2 ||
		plan.Request.Metrics[0].Name != "activeUsers" ||
		plan.Request.Metrics[1].Name != "sessions" {
		t.Fatalf("unexpected request metrics: %#v", plan.Request.Metrics)
	}
}

func TestNewAnalyticsReportPlanValidation(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name    string
		input   analyticsReportInput
		wantErr string
	}{
		{
			name: "property",
			input: analyticsReportInput{
				Metrics: "activeUsers",
				Max:     100,
			},
			wantErr: "empty property",
		},
		{
			name: "metrics",
			input: analyticsReportInput{
				Property: "123",
				Max:      100,
			},
			wantErr: "empty --metrics",
		},
		{
			name: "max",
			input: analyticsReportInput{
				Property: "123",
				Metrics:  "activeUsers",
			},
			wantErr: "--max must be > 0",
		},
		{
			name: "offset",
			input: analyticsReportInput{
				Property: "123",
				Metrics:  "activeUsers",
				Max:      100,
				Offset:   -1,
			},
			wantErr: "--offset must be >= 0",
		},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			_, err := newAnalyticsReportPlan(testCase.input)
			if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("newAnalyticsReportPlan() error = %v, want %q", err, testCase.wantErr)
			}
		})
	}
}
