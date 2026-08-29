package sheetsa1

import (
	"testing"

	"google.golang.org/api/sheets/v4"
)

func TestColumnLetters(t *testing.T) {
	for _, test := range []struct {
		column int
		want   string
	}{
		{column: 1, want: "A"},
		{column: 26, want: "Z"},
		{column: 27, want: "AA"},
		{column: 703, want: "AAA"},
	} {
		got, err := ColumnLetters(test.column)
		if err != nil {
			t.Fatalf("ColumnLetters(%d) error = %v", test.column, err)
		}

		if got != test.want {
			t.Fatalf("ColumnLetters(%d) = %q, want %q", test.column, got, test.want)
		}
	}

	if _, err := ColumnLetters(0); err == nil {
		t.Fatal("expected invalid column error")
	}
}

func TestSheetPrefixAndFormatCell(t *testing.T) {
	if got := SheetPrefix("Sheet1"); got != "Sheet1!" {
		t.Fatalf("simple prefix = %q", got)
	}

	if got := SheetPrefix("  O'Brien  "); got != "'  O''Brien  '!" {
		t.Fatalf("quoted prefix = %q", got)
	}

	if got := FormatCell("Data Set", 5, 2); got != "'Data Set'!B5" {
		t.Fatalf("cell = %q", got)
	}
}

func TestFormatGridRange(t *testing.T) {
	for _, test := range []struct {
		name       string
		sheetTitle string
		gridRange  *sheets.GridRange
		want       string
	}{
		{
			name:       "single cell preserves title whitespace",
			sheetTitle: "  Sheet One  ",
			gridRange: &sheets.GridRange{
				SheetId:          1,
				EndRowIndex:      1,
				EndColumnIndex:   1,
				StartRowIndex:    0,
				StartColumnIndex: 0,
			},
			want: "'  Sheet One  '!A1",
		},
		{
			name:       "rectangle",
			sheetTitle: "Sheet1",
			gridRange: &sheets.GridRange{
				StartRowIndex:    1,
				EndRowIndex:      4,
				StartColumnIndex: 2,
				EndColumnIndex:   5,
			},
			want: "Sheet1!C2:E4",
		},
		{
			name:       "columns",
			sheetTitle: "Sheet1",
			gridRange:  &sheets.GridRange{EndColumnIndex: 2},
			want:       "Sheet1!A:B",
		},
		{
			name:       "rows",
			sheetTitle: "Sheet1",
			gridRange:  &sheets.GridRange{EndRowIndex: 10},
			want:       "Sheet1!1:10",
		},
		{
			name:      "sheet ID fallback",
			gridRange: &sheets.GridRange{SheetId: 7},
			want:      "sheetId:7",
		},
		{
			name:       "unrepresentable open start",
			sheetTitle: "Sheet1",
			gridRange:  &sheets.GridRange{StartRowIndex: 5},
			want:       "",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := FormatGridRange(test.sheetTitle, test.gridRange); got != test.want {
				t.Fatalf("FormatGridRange() = %q, want %q", got, test.want)
			}
		})
	}
}
