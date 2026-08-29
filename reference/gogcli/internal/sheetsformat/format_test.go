package sheetsformat

import (
	"testing"

	"google.golang.org/api/sheets/v4"
)

func TestApplyForceSendFields(t *testing.T) {
	tests := []struct {
		name string
		path string
		want func(*sheets.CellFormat) bool
	}{
		{
			name: "text format bold",
			path: "textFormat.bold",
			want: func(format *sheets.CellFormat) bool {
				return format.TextFormat != nil && hasString(format.TextFormat.ForceSendFields, "Bold")
			},
		},
		{
			name: "number format type",
			path: "numberFormat.type",
			want: func(format *sheets.CellFormat) bool {
				return format.NumberFormat != nil && hasString(format.NumberFormat.ForceSendFields, "Type")
			},
		},
		{
			name: "borders top style",
			path: "borders.top.style",
			want: func(format *sheets.CellFormat) bool {
				return format.Borders != nil &&
					format.Borders.Top != nil &&
					hasString(format.Borders.Top.ForceSendFields, "Style")
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			format := sheets.CellFormat{}
			if err := ApplyForceSendFields(&format, []string{test.path}); err != nil {
				t.Fatalf("ApplyForceSendFields() error = %v", err)
			}

			if !test.want(&format) {
				t.Fatalf("format = %#v", format)
			}
		})
	}
}

func TestApplyForceSendFieldsRejectsInvalidInput(t *testing.T) {
	format := sheets.CellFormat{}
	if err := ApplyForceSendFields(&format, []string{"nope"}); err == nil {
		t.Fatal("expected error for unknown field")
	}

	if err := ApplyForceSendFields(nil, []string{"textFormat.bold"}); err == nil {
		t.Fatal("expected error for nil format")
	}
}

func TestNormalizeMask(t *testing.T) {
	normalized, paths := NormalizeMask("textFormat.bold, userEnteredFormat.textFormat.italic, userEnteredValue")
	if normalized != "userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.italic,userEnteredValue" {
		t.Fatalf("normalized = %q", normalized)
	}

	if len(paths) != 2 || paths[0] != "textFormat.bold" || paths[1] != "textFormat.italic" {
		t.Fatalf("paths = %#v", paths)
	}

	normalized, paths = NormalizeMask("userEnteredFormat")
	if normalized != "userEnteredFormat" || len(paths) != 0 {
		t.Fatalf("user entered format mask = %q, %#v", normalized, paths)
	}

	normalized, paths = NormalizeMask("note")
	if normalized != "note" || len(paths) != 0 {
		t.Fatalf("unknown mask = %q, %#v", normalized, paths)
	}
}

func TestInferMask(t *testing.T) {
	normalized, paths, err := InferMask(
		[]byte(`{"backgroundColor":{"red":0,"green":0.5,"blue":1},"textFormat":{"bold":false}}`),
	)
	if err != nil {
		t.Fatalf("InferMask() error = %v", err)
	}

	want := "userEnteredFormat.backgroundColor.blue,userEnteredFormat.backgroundColor.green,userEnteredFormat.backgroundColor.red,userEnteredFormat.textFormat.bold"
	if normalized != want {
		t.Fatalf("normalized = %q, want %q", normalized, want)
	}

	wantPaths := []string{"backgroundColor.blue", "backgroundColor.green", "backgroundColor.red", "textFormat.bold"}
	if len(paths) != len(wantPaths) {
		t.Fatalf("paths = %#v, want %#v", paths, wantPaths)
	}

	for i := range wantPaths {
		if paths[i] != wantPaths[i] {
			t.Fatalf("paths = %#v, want %#v", paths, wantPaths)
		}
	}
}

func TestDecode(t *testing.T) {
	var format sheets.CellFormat
	if err := Decode([]byte(`{"textFormat":{"bold":false}}`), &format); err != nil {
		t.Fatalf("Decode() error = %v", err)
	}

	if format.TextFormat == nil {
		t.Fatal("missing text format")
	}

	if err := Decode([]byte(`{"unknown":true}`), &format); err == nil {
		t.Fatal("expected unknown field error")
	}
}

func TestHasBordersTypo(t *testing.T) {
	if !HasBordersTypo("boarders.top.style") {
		t.Fatal("expected typo detection for boarders")
	}

	if !HasBordersTypo("userEnteredFormat.boarders.top.style") {
		t.Fatal("expected typo detection for userEnteredFormat.boarders")
	}

	if HasBordersTypo("borders.top.style") {
		t.Fatal("did not expect typo detection for borders")
	}
}

func hasString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}

	return false
}
