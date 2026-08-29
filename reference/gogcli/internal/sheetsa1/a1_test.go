package sheetsa1

import "testing"

func TestParse(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want Range
	}{
		{
			name: "simple",
			in:   "Sheet1!A2:B3",
			want: Range{SheetName: "Sheet1", StartRow: 2, EndRow: 3, StartCol: 1, EndCol: 2},
		},
		{
			name: "quoted sheet",
			in:   "'My Sheet'!C1:D2",
			want: Range{SheetName: "My Sheet", StartRow: 1, EndRow: 2, StartCol: 3, EndCol: 4},
		},
		{
			name: "escaped quote",
			in:   "'Bob''s Sheet'!AA10:AB11",
			want: Range{SheetName: "Bob's Sheet", StartRow: 10, EndRow: 11, StartCol: 27, EndCol: 28},
		},
		{
			name: "reordered",
			in:   "Sheet1!C3:A1",
			want: Range{SheetName: "Sheet1", StartRow: 1, EndRow: 3, StartCol: 1, EndCol: 3},
		},
		{
			name: "columns",
			in:   "Sheet1!A:C",
			want: Range{SheetName: "Sheet1", StartCol: 1, EndCol: 3},
		},
		{
			name: "rows",
			in:   "Sheet1!2:10",
			want: Range{SheetName: "Sheet1", StartRow: 2, EndRow: 10},
		},
		{
			name: "open ended rows",
			in:   "Sheet1!B5:D",
			want: Range{SheetName: "Sheet1", StartRow: 5, StartCol: 2, EndCol: 4},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := Parse(test.in)
			if err != nil {
				t.Fatalf("Parse() error = %v", err)
			}

			if got != test.want {
				t.Fatalf("Parse() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestParseRejectsInvalidRanges(t *testing.T) {
	for _, input := range []string{
		"Sheet1!A",
		"Sheet1!GKGWBYLWRXTLPQ1",
		"Sheet1!",
		"",
	} {
		t.Run(input, func(t *testing.T) {
			if _, err := Parse(input); err == nil {
				t.Fatalf("Parse(%q) expected error", input)
			}
		})
	}
}

func TestSplitUsesLastBang(t *testing.T) {
	sheet, rangePart, err := Split("'Q1!Q2'!A1")
	if err != nil {
		t.Fatalf("Split() error = %v", err)
	}

	if sheet != "Q1!Q2" || rangePart != "A1" {
		t.Fatalf("Split() = %q, %q", sheet, rangePart)
	}
}
