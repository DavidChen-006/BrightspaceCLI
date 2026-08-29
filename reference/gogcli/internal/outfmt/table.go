package outfmt

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
)

var errNoTableColumns = errors.New("write table: no columns")

type Column[T any] struct {
	Header string
	Value  func(T) string
}

func WriteTable[T any](ctx context.Context, w io.Writer, rows []T, columns []Column[T]) error {
	if len(columns) == 0 {
		return errNoTableColumns
	}

	target := w

	var aligned *tabwriter.Writer
	if !IsPlain(ctx) {
		aligned = tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
		target = aligned
	}

	headers := make([]string, len(columns))
	for i, column := range columns {
		headers[i] = column.Header
	}

	if err := writeTableLine(target, headers); err != nil {
		return fmt.Errorf("write table header: %w", err)
	}

	values := make([]string, len(columns))
	for _, row := range rows {
		for i, column := range columns {
			values[i] = column.Value(row)
		}

		if err := writeTableLine(target, values); err != nil {
			return fmt.Errorf("write table row: %w", err)
		}
	}

	if aligned != nil {
		if err := aligned.Flush(); err != nil {
			return fmt.Errorf("flush table: %w", err)
		}
	}

	return nil
}

func writeTableLine(w io.Writer, values []string) error {
	_, err := io.WriteString(w, strings.Join(values, "\t")+"\n")
	if err != nil {
		return fmt.Errorf("write line: %w", err)
	}

	return nil
}
