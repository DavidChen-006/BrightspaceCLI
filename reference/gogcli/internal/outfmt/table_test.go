package outfmt

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
)

type tableTestRow struct {
	ID   string
	Name string
}

func tableTestColumns() []Column[tableTestRow] {
	return []Column[tableTestRow]{
		{Header: "ID", Value: func(row tableTestRow) string { return row.ID }},
		{Header: "NAME", Value: func(row tableTestRow) string { return row.Name }},
	}
}

func TestWriteTablePlain(t *testing.T) {
	ctx := WithMode(context.Background(), Mode{Plain: true})
	var out bytes.Buffer

	err := WriteTable(ctx, &out, []tableTestRow{
		{ID: "1", Name: "one"},
		{ID: "22", Name: "two"},
	}, tableTestColumns())
	if err != nil {
		t.Fatalf("WriteTable: %v", err)
	}

	const want = "ID\tNAME\n1\tone\n22\ttwo\n"
	if got := out.String(); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestWriteTableAligned(t *testing.T) {
	var out bytes.Buffer

	err := WriteTable(context.Background(), &out, []tableTestRow{
		{ID: "1", Name: "one"},
		{ID: "22", Name: "two"},
	}, tableTestColumns())
	if err != nil {
		t.Fatalf("WriteTable: %v", err)
	}

	const want = "ID  NAME\n1   one\n22  two\n"
	if got := out.String(); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestWriteTableRejectsEmptySchema(t *testing.T) {
	err := WriteTable[tableTestRow](context.Background(), &bytes.Buffer{}, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestWriteTableReturnsWriterError(t *testing.T) {
	wantErr := io.ErrClosedPipe

	err := WriteTable(
		WithMode(context.Background(), Mode{Plain: true}),
		errorWriter{err: wantErr},
		[]tableTestRow{{ID: "1", Name: "one"}},
		tableTestColumns(),
	)
	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
}

type errorWriter struct {
	err error
}

func (w errorWriter) Write([]byte) (int, error) {
	return 0, w.err
}
