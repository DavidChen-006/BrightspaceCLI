package sheetschart

import (
	"slices"
	"strings"
	"testing"

	"google.golang.org/api/sheets/v4"
)

func TestParseEmbeddedAndSpec(t *testing.T) {
	chart, err := ParseEmbedded([]byte(`{"spec":{"title":"Embedded"}}`))
	if err != nil {
		t.Fatalf("ParseEmbedded() error = %v", err)
	}

	if chart.Spec == nil || chart.Spec.Title != "Embedded" {
		t.Fatalf("chart = %#v", chart)
	}

	spec, err := ParseSpec([]byte(`{"title":"Direct"}`))
	if err != nil {
		t.Fatalf("ParseSpec() error = %v", err)
	}

	if spec.Title != "Direct" {
		t.Fatalf("spec = %#v", spec)
	}

	if _, err := ParseSpec([]byte(`{}`)); err == nil ||
		!strings.Contains(err.Error(), "must contain a ChartSpec") {
		t.Fatalf("empty spec error = %v", err)
	}
}

func TestNormalizeZeroSheetIDs(t *testing.T) {
	spec := &sheets.ChartSpec{
		BasicChart: &sheets.BasicChartSpec{
			Domains: []*sheets.BasicChartDomain{{
				Domain: &sheets.ChartData{
					SourceRange: &sheets.ChartSourceRange{
						Sources: []*sheets.GridRange{{
							SheetId:       0,
							StartRowIndex: 1,
							EndRowIndex:   4,
						}},
					},
				},
			}},
			Series: []*sheets.BasicChartSeries{{
				Series: &sheets.ChartData{
					SourceRange: &sheets.ChartSourceRange{
						Sources: []*sheets.GridRange{{
							SheetId:       42,
							StartRowIndex: 1,
							EndRowIndex:   4,
						}},
					},
				},
			}},
		},
	}

	if !HasZeroSheetIDs(spec) {
		t.Fatal("expected zero sheet ID")
	}

	NormalizeZeroSheetIDs(spec, 123, false)

	domainRange := spec.BasicChart.Domains[0].Domain.SourceRange.Sources[0]
	if domainRange.SheetId != 123 {
		t.Fatalf("domain sheetId = %d, want 123", domainRange.SheetId)
	}

	if !slices.Contains(domainRange.ForceSendFields, "SheetId") {
		t.Fatalf("domain ForceSendFields = %v, want SheetId", domainRange.ForceSendFields)
	}

	if HasZeroSheetIDs(spec) {
		t.Fatal("zero sheet ID remains")
	}

	seriesRange := spec.BasicChart.Series[0].Series.SourceRange.Sources[0]
	if seriesRange.SheetId != 42 {
		t.Fatalf("explicit series sheetId = %d, want 42", seriesRange.SheetId)
	}
}

func TestNormalizeZeroSheetIDsPreservesRealZero(t *testing.T) {
	gridRange := &sheets.GridRange{}
	spec := &sheets.ChartSpec{
		BasicChart: &sheets.BasicChartSpec{
			Domains: []*sheets.BasicChartDomain{{
				Domain: &sheets.ChartData{
					SourceRange: &sheets.ChartSourceRange{
						Sources: []*sheets.GridRange{gridRange},
					},
				},
			}},
		},
	}

	NormalizeZeroSheetIDs(spec, 99, true)

	if gridRange.SheetId != 0 || !slices.Contains(gridRange.ForceSendFields, "SheetId") {
		t.Fatalf("grid range = %#v", gridRange)
	}
}

func TestParseAnchor(t *testing.T) {
	for _, test := range []struct {
		input   string
		wantRow int
		wantCol int
		wantErr bool
	}{
		{input: "A1", wantRow: 1, wantCol: 1},
		{input: "B5", wantRow: 5, wantCol: 2},
		{input: "Z26", wantRow: 26, wantCol: 26},
		{input: "AA1", wantRow: 1, wantCol: 27},
		{input: "E10", wantRow: 10, wantCol: 5},
		{input: "", wantErr: true},
		{input: "1A", wantErr: true},
		{input: "A", wantErr: true},
		{input: "A0", wantErr: true},
	} {
		t.Run(test.input, func(t *testing.T) {
			got, err := ParseAnchor(test.input)
			if test.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q", test.input)
				}

				return
			}

			if err != nil {
				t.Fatalf("ParseAnchor(%q) error = %v", test.input, err)
			}

			if got.Row != test.wantRow || got.Col != test.wantCol {
				t.Fatalf("ParseAnchor(%q) = %#v", test.input, got)
			}
		})
	}
}

func TestBuildPosition(t *testing.T) {
	position, err := BuildPosition(7, "B5", 600, 371)
	if err != nil {
		t.Fatalf("BuildPosition() error = %v", err)
	}

	overlay := position.OverlayPosition
	if overlay == nil ||
		overlay.AnchorCell == nil ||
		overlay.AnchorCell.SheetId != 7 ||
		overlay.AnchorCell.RowIndex != 4 ||
		overlay.AnchorCell.ColumnIndex != 1 ||
		overlay.WidthPixels != 600 ||
		overlay.HeightPixels != 371 {
		t.Fatalf("position = %#v", position)
	}
}
