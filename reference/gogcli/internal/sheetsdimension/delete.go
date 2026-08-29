package sheetsdimension

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"google.golang.org/api/sheets/v4"
)

const (
	Rows    = "ROWS"
	Columns = "COLUMNS"
)

var (
	errEmptyTableRange   = errors.New("empty table range")
	errInvalidTableRange = errors.New("invalid bounded table range")
)

type ValidationError string

func (e ValidationError) Error() string {
	return string(e)
}

type DeleteSpec struct {
	SheetName  string
	Dimension  string
	Label      string
	StartIndex int64
	EndIndex   int64
}

type TableUpdate struct {
	TableID string
	Name    string
	Before  *sheets.GridRange
	After   *sheets.GridRange
}

func ValidateBounds(spec DeleteSpec, props *sheets.SheetProperties) error {
	if props == nil || props.GridProperties == nil {
		return nil
	}

	var size int64
	if spec.Dimension == Rows {
		size = props.GridProperties.RowCount
	} else {
		size = props.GridProperties.ColumnCount
	}

	if size <= 0 {
		return nil
	}

	if spec.EndIndex > size {
		return invalidf("%s end %d exceeds sheet size %d", spec.Label, spec.EndIndex, size)
	}

	if spec.StartIndex == 0 && spec.EndIndex == size {
		return invalidf("cannot delete every %s in a sheet", spec.Label[:len(spec.Label)-1])
	}

	return nil
}

func PlanTableUpdates(
	tables []*sheets.Table,
	sheetID int64,
	spec DeleteSpec,
) ([]TableUpdate, error) {
	updates := make([]TableUpdate, 0)

	for _, table := range tables {
		if table == nil || table.Range == nil || table.Range.SheetId != sheetID {
			continue
		}

		after, intersects, err := ResizeTableRange(table.Range, spec)
		if err != nil {
			label := strings.TrimSpace(table.Name)
			if label == "" {
				label = strings.TrimSpace(table.TableId)
			}

			return nil, invalidf(
				"cannot delete %s %d-%d: table %q would lose its entire %s extent",
				spec.Label,
				spec.StartIndex+1,
				spec.EndIndex,
				label,
				spec.Label[:len(spec.Label)-1],
			)
		}

		if !intersects {
			continue
		}

		if after.SheetId == 0 {
			after.ForceSendFields = append(after.ForceSendFields, "SheetId")
		}

		updates = append(updates, TableUpdate{
			TableID: strings.TrimSpace(table.TableId),
			Name:    strings.TrimSpace(table.Name),
			Before:  table.Range,
			After:   after,
		})
	}

	sort.Slice(updates, func(i, j int) bool {
		if updates[i].TableID == updates[j].TableID {
			return updates[i].Name < updates[j].Name
		}

		return updates[i].TableID < updates[j].TableID
	})

	return updates, nil
}

func ResizeTableRange(tableRange *sheets.GridRange, spec DeleteSpec) (*sheets.GridRange, bool, error) {
	if tableRange == nil {
		return nil, false, nil
	}

	var tableStart, tableEnd int64
	if spec.Dimension == Rows {
		tableStart, tableEnd = tableRange.StartRowIndex, tableRange.EndRowIndex
	} else {
		tableStart, tableEnd = tableRange.StartColumnIndex, tableRange.EndColumnIndex
	}

	if tableEnd <= tableStart {
		return nil, false, errInvalidTableRange
	}

	if spec.EndIndex <= tableStart || spec.StartIndex >= tableEnd {
		return nil, false, nil
	}

	afterStart := boundaryAfterDelete(tableStart, spec.StartIndex, spec.EndIndex)

	afterEnd := boundaryAfterDelete(tableEnd, spec.StartIndex, spec.EndIndex)
	if afterEnd <= afterStart {
		return nil, true, errEmptyTableRange
	}

	after := *tableRange

	after.ForceSendFields = append([]string(nil), tableRange.ForceSendFields...)
	if spec.Dimension == Rows {
		after.StartRowIndex = afterStart
		after.EndRowIndex = afterEnd
	} else {
		after.StartColumnIndex = afterStart
		after.EndColumnIndex = afterEnd
	}

	return &after, true, nil
}

func boundaryAfterDelete(boundary, deleteStart, deleteEnd int64) int64 {
	switch {
	case boundary <= deleteStart:
		return boundary
	case boundary >= deleteEnd:
		return boundary - (deleteEnd - deleteStart)
	default:
		return deleteStart
	}
}

func invalidf(format string, args ...any) error {
	return ValidationError(fmt.Sprintf(format, args...))
}
