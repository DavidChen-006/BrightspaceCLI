package cmd

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseTableValuesJSON_EmptyProducesAllEmptyMatrix(t *testing.T) {
	got, err := parseTableValuesJSON("", 2, 3)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := [][]string{{"", "", ""}, {"", "", ""}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestParseTableValuesJSON_PopulatedMatrixRoundTrip(t *testing.T) {
	got, err := parseTableValuesJSON(`[["a","b","c"],["d","e","f"]]`, 2, 3)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := [][]string{{"a", "b", "c"}, {"d", "e", "f"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestParseTableValuesJSON_RowCountMismatch(t *testing.T) {
	_, err := parseTableValuesJSON(`[["a","b"]]`, 2, 2)
	if err == nil || !strings.Contains(err.Error(), "row count 1 does not match --rows 2") {
		t.Fatalf("expected row-count error, got %v", err)
	}
}

func TestParseTableValuesJSON_ColumnCountMismatch(t *testing.T) {
	_, err := parseTableValuesJSON(`[["a","b"],["c"]]`, 2, 2)
	if err == nil || !strings.Contains(err.Error(), "row 1 has 1 columns, want 2") {
		t.Fatalf("expected column-count error, got %v", err)
	}
}

func TestParseTableValuesJSON_InvalidJSONRejected(t *testing.T) {
	_, err := parseTableValuesJSON(`[not json]`, 1, 1)
	if err == nil || !strings.Contains(err.Error(), "--values-json must be a JSON 2D string array") {
		t.Fatalf("expected JSON parse error, got %v", err)
	}
}

func TestDocsInsertTableCmd_FlagValidation(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com"}
	ctx := newDocsCmdContext(t)

	cases := []struct {
		name string
		args []string
		want string
	}{
		{"rows < 1", []string{"doc1", "--rows", "0", "--cols", "2"}, "--rows must be >= 1"},
		{"cols < 1", []string{"doc1", "--rows", "2", "--cols", "0"}, "--cols must be >= 1"},
		{"index + at-end conflict", []string{"doc1", "--rows", "2", "--cols", "2", "--index", "5", "--at-end"}, "mutually exclusive"},
		{"zero index", []string{"doc1", "--rows", "2", "--cols", "2", "--index", "0"}, "--index must be >= 1"},
		{"negative index", []string{"doc1", "--rows", "2", "--cols", "2", "--index=-1"}, "--index must be >= 1"},
		{"values-json dims wrong", []string{"doc1", "--rows", "2", "--cols", "2", "--values-json", `[["a","b"]]`}, "row count 1 does not match --rows 2"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			err := runKong(t, &DocsInsertTableCmd{}, tt.args, ctx, flags)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected error containing %q, got %v", tt.want, err)
			}
		})
	}
}
