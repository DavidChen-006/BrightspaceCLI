package sheetsdimension

import (
	"strings"
	"testing"
)

func TestParseColumns(t *testing.T) {
	span, err := ParseColumns("Sheet 1!$C:$A", "columns")
	if err != nil {
		t.Fatalf("ParseColumns() error = %v", err)
	}

	if span.SheetName != "Sheet 1" || span.StartIndex != 0 || span.EndIndex != 3 {
		t.Fatalf("span = %#v", span)
	}

	if _, err := ParseColumns("Sheet1!1:3", "columns"); err == nil {
		t.Fatal("expected invalid column range")
	}

	if _, err := ParseColumns("Sheet1!GKGWBYLWRXTLPQ", "columns"); err == nil ||
		!strings.Contains(err.Error(), "too large") {
		t.Fatalf("overflow error = %v", err)
	}
}

func TestParseRows(t *testing.T) {
	span, err := ParseRows("Sheet 1!$4:$2", "rows")
	if err != nil {
		t.Fatalf("ParseRows() error = %v", err)
	}

	if span.SheetName != "Sheet 1" || span.StartIndex != 1 || span.EndIndex != 4 {
		t.Fatalf("span = %#v", span)
	}

	if _, err := ParseRows("Sheet1!0:2", "rows"); err == nil {
		t.Fatal("expected invalid row range")
	}
}

func TestParseDeleteSpec(t *testing.T) {
	literalSheet, err := ParseDeleteSpec("Q1!Q2", "columns", 2, 4)
	if err != nil {
		t.Fatalf("ParseDeleteSpec() literal sheet error = %v", err)
	}

	if literalSheet.SheetName != "Q1!Q2" || literalSheet.StartIndex != 1 || literalSheet.EndIndex != 4 {
		t.Fatalf("literal sheet spec = %#v", literalSheet)
	}

	rangeSpec, err := ParseDeleteSpec("'Data Sheet'!B:C", "columns", 0, 0)
	if err != nil {
		t.Fatalf("ParseDeleteSpec() range error = %v", err)
	}

	if rangeSpec.SheetName != "Data Sheet" ||
		rangeSpec.Dimension != Columns ||
		rangeSpec.StartIndex != 1 ||
		rangeSpec.EndIndex != 3 {
		t.Fatalf("range spec = %#v", rangeSpec)
	}

	for _, tc := range []struct {
		name      string
		target    string
		dimension string
		start     int64
		end       int64
		want      string
	}{
		{name: "missing spans", target: "Data", dimension: "ROWS", want: "require both --start and --end"},
		{name: "ambiguous bare column", target: "B", dimension: "COLUMNS", want: "must include a sheet name"},
		{name: "ambiguous bare row", target: "2025", dimension: "ROWS", want: "must include a sheet name"},
		{name: "column overflow", target: "Data!GKGWBYLWRXTLPQ", dimension: "COLUMNS", want: "too large"},
		{name: "one bound", target: "Data", dimension: "ROWS", start: 2, want: "provide both"},
		{name: "bad dimension", target: "Data", dimension: "CELLS", start: 2, end: 4, want: "ROWS or COLUMNS"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, gotErr := ParseDeleteSpec(tc.target, tc.dimension, tc.start, tc.end)
			if gotErr == nil || !strings.Contains(gotErr.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", gotErr, tc.want)
			}
		})
	}
}
