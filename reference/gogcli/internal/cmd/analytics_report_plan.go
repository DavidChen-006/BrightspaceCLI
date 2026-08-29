package cmd

import (
	"strings"

	analyticsdata "google.golang.org/api/analyticsdata/v1beta"
)

type analyticsReportInput struct {
	Property   string
	From       string
	To         string
	Dimensions string
	Metrics    string
	Max        int64
	Offset     int64
}

type analyticsReportPlan struct {
	Property   string
	From       string
	To         string
	Dimensions []string
	Metrics    []string
	Request    *analyticsdata.RunReportRequest
}

func newAnalyticsReportPlan(input analyticsReportInput) (analyticsReportPlan, error) {
	plan := analyticsReportPlan{
		Property:   normalizeAnalyticsProperty(input.Property),
		From:       strings.TrimSpace(input.From),
		To:         strings.TrimSpace(input.To),
		Dimensions: splitCommaList(input.Dimensions),
		Metrics:    splitCommaList(input.Metrics),
	}
	if plan.Property == "" {
		return analyticsReportPlan{}, usage("empty property")
	}
	if len(plan.Metrics) == 0 {
		return analyticsReportPlan{}, usage("empty --metrics")
	}
	if input.Max <= 0 {
		return analyticsReportPlan{}, usage("--max must be > 0")
	}
	if input.Offset < 0 {
		return analyticsReportPlan{}, usage("--offset must be >= 0")
	}

	plan.Request = &analyticsdata.RunReportRequest{
		DateRanges: []*analyticsdata.DateRange{{
			StartDate: plan.From,
			EndDate:   plan.To,
		}},
		Metrics: analyticsMetrics(plan.Metrics),
		Limit:   input.Max,
		Offset:  input.Offset,
	}
	if len(plan.Dimensions) > 0 {
		plan.Request.Dimensions = analyticsDimensions(plan.Dimensions)
	}
	return plan, nil
}

func normalizeAnalyticsProperty(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "properties/") {
		return raw
	}
	return "properties/" + strings.TrimPrefix(raw, "/")
}

func analyticsDimensions(names []string) []*analyticsdata.Dimension {
	out := make([]*analyticsdata.Dimension, 0, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		out = append(out, &analyticsdata.Dimension{Name: name})
	}
	return out
}

func analyticsMetrics(names []string) []*analyticsdata.Metric {
	out := make([]*analyticsdata.Metric, 0, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		out = append(out, &analyticsdata.Metric{Name: name})
	}
	return out
}
