package docstable

import (
	"fmt"

	"google.golang.org/api/docs/v1"
)

type ValidationError string

func (e ValidationError) Error() string {
	return string(e)
}

type Dimension string

const (
	Row    Dimension = "row"
	Column Dimension = "column"
)

type Action string

const (
	Insert  Action = "insert"
	Delete  Action = "delete"
	Merge   Action = "merge"
	Unmerge Action = "unmerge"
	Split   Action = "split"
)

type Target struct {
	Table      *docs.Table
	StartIndex int64
}

func BuildDimensionRequest(
	target Target,
	dimension Dimension,
	action Action,
	requested int,
	appendAtEnd bool,
	tabID string,
) (*docs.Request, int, error) {
	if target.Table == nil {
		return nil, 0, invalid("target table is empty")
	}

	if dimension != Row && dimension != Column {
		return nil, 0, invalidf("unsupported table dimension %q", dimension)
	}

	count := len(target.Table.TableRows)
	if dimension == Column {
		count = ColumnCount(target.Table)
	}

	if count < 1 {
		return nil, 0, invalidf("target table has no %ss", dimension)
	}

	resolved := requested
	if appendAtEnd {
		resolved = count + 1
	} else if resolved < 0 {
		resolved = count + resolved + 1
	}

	switch action {
	case Delete:
		if resolved < 1 || resolved > count {
			return nil, 0, invalidf("%s %d out of range (table has %d %ss)", dimension, requested, count, dimension)
		}

		if count == 1 {
			return nil, 0, invalidf("cannot delete the only %s in a table", dimension)
		}
	case Insert:
		if !appendAtEnd && (resolved < 1 || resolved > count) {
			return nil, 0, invalidf("%s %d out of range for insert (table has %d %ss)", dimension, requested, count, dimension)
		}
	default:
		return nil, 0, invalidf("unsupported table %s action %q", dimension, action)
	}

	rowIndex, columnIndex, err := dimensionReference(target.Table, dimension, action, resolved, appendAtEnd)
	if err != nil {
		return nil, 0, err
	}
	cellLocation := &docs.TableCellLocation{
		TableStartLocation: &docs.Location{Index: target.StartIndex, TabId: tabID},
		RowIndex:           int64(rowIndex),
		ColumnIndex:        int64(columnIndex),
		ForceSendFields:    []string{"RowIndex", "ColumnIndex"},
	}

	if dimension == Row {
		if action == Delete {
			return &docs.Request{DeleteTableRow: &docs.DeleteTableRowRequest{
				TableCellLocation: cellLocation,
			}}, resolved, nil
		}

		return &docs.Request{InsertTableRow: &docs.InsertTableRowRequest{
			TableCellLocation: cellLocation,
			InsertBelow:       appendAtEnd,
		}}, resolved, nil
	}

	if action == Delete {
		return &docs.Request{DeleteTableColumn: &docs.DeleteTableColumnRequest{
			TableCellLocation: cellLocation,
		}}, resolved, nil
	}

	return &docs.Request{InsertTableColumn: &docs.InsertTableColumnRequest{
		TableCellLocation: cellLocation,
		InsertRight:       appendAtEnd,
	}}, resolved, nil
}

func BuildMergeRequest(
	target Target,
	action Action,
	startRow, startCol, endRow, endCol int,
	tabID string,
) (*docs.Request, error) {
	if err := ValidateRange(target.Table, startRow, startCol, endRow, endCol); err != nil {
		return nil, err
	}
	tableRange := &docs.TableRange{
		TableCellLocation: &docs.TableCellLocation{
			TableStartLocation: &docs.Location{Index: target.StartIndex, TabId: tabID},
			RowIndex:           int64(startRow - 1),
			ColumnIndex:        int64(startCol - 1),
			ForceSendFields:    []string{"RowIndex", "ColumnIndex"},
		},
		RowSpan:    int64(endRow - startRow + 1),
		ColumnSpan: int64(endCol - startCol + 1),
	}

	switch action {
	case Merge:
		return &docs.Request{MergeTableCells: &docs.MergeTableCellsRequest{TableRange: tableRange}}, nil
	case Unmerge, Split:
		tableRange.RowSpan = 1
		tableRange.ColumnSpan = 1

		return &docs.Request{UnmergeTableCells: &docs.UnmergeTableCellsRequest{TableRange: tableRange}}, nil
	default:
		return nil, invalidf("unsupported table merge action %q", action)
	}
}

func ValidateRange(table *docs.Table, startRow, startCol, endRow, endCol int) error {
	rows := 0
	if table != nil {
		rows = len(table.TableRows)
	}

	if startRow < 1 || startRow > rows {
		return invalidf("row %d out of range (table has %d rows)", startRow, rows)
	}

	if endRow < startRow || endRow > rows {
		return invalidf("row %d out of range (table has %d rows)", endRow, rows)
	}

	columns := ColumnCount(table)
	if columns == 0 {
		for _, placement := range cellPlacements(table) {
			if placement.columnEnd() > columns {
				columns = placement.columnEnd()
			}
		}
	}

	if startCol < 1 || startCol > columns {
		return invalidf("col %d out of range (table has %d columns)", startCol, columns)
	}

	if endCol < startCol || endCol > columns {
		return invalidf("col %d out of range (table has %d columns)", endCol, columns)
	}

	return nil
}

func ColumnCount(table *docs.Table) int {
	if table == nil {
		return 0
	}

	if table.Columns > 0 {
		return int(table.Columns)
	}

	if len(table.TableRows) > 0 {
		return len(table.TableRows[0].TableCells)
	}

	return 0
}

func RowBoundaryCrossesMerge(table *docs.Table, row int) bool {
	for _, placement := range cellPlacements(table) {
		if placement.rowStart < row && placement.rowEnd() >= row {
			return true
		}
	}

	return false
}

func dimensionReference(
	table *docs.Table,
	dimension Dimension,
	action Action,
	resolved int,
	appendAtEnd bool,
) (int, int, error) {
	if !hasRectangularRows(table) {
		return 0, 0, invalidf(
			"cannot %s table %s on a non-rectangular table; merge/unmerge cells or normalize the table first",
			action, dimension,
		)
	}

	placements := cellPlacements(table)
	if dimension == Column {
		for _, placement := range placements {
			switch {
			case action == Delete && placement.columnSpan == 1 && placement.columnStart == resolved:
				return placement.rowStart - 1, resolved - 1, nil
			case action == Insert && !appendAtEnd && placement.columnStart == resolved:
				return placement.rowStart - 1, resolved - 1, nil
			case action == Insert && appendAtEnd && placement.columnEnd() == resolved-1:
				return placement.rowStart - 1, resolved - 2, nil
			}
		}

		if action == Delete {
			return 0, 0, invalidf("cannot delete column %d because every reference cell spanning it is merged", resolved)
		}

		return 0, 0, invalidf("cannot insert at column %d because the boundary is inside merged cells", resolved)
	}

	for _, placement := range placements {
		switch {
		case action == Delete && placement.rowSpan == 1 && placement.rowStart == resolved:
			return resolved - 1, placement.columnStart - 1, nil
		case action == Insert && !appendAtEnd && placement.rowStart == resolved:
			return resolved - 1, placement.columnStart - 1, nil
		case action == Insert && appendAtEnd && placement.rowEnd() == resolved-1:
			return resolved - 2, placement.columnStart - 1, nil
		}
	}

	if action == Delete {
		return 0, 0, invalidf("cannot delete row %d because every reference cell spanning it is merged", resolved)
	}

	return 0, 0, invalidf("cannot insert at row %d because the boundary is inside merged cells", resolved)
}

func cellColumnSpan(cell *docs.TableCell) int {
	if cell != nil && cell.TableCellStyle != nil && cell.TableCellStyle.ColumnSpan > 0 {
		return int(cell.TableCellStyle.ColumnSpan)
	}

	return 1
}

func cellRowSpan(cell *docs.TableCell) int {
	if cell != nil && cell.TableCellStyle != nil && cell.TableCellStyle.RowSpan > 0 {
		return int(cell.TableCellStyle.RowSpan)
	}

	return 1
}

type cellPlacement struct {
	rowStart    int
	columnStart int
	rowSpan     int
	columnSpan  int
}

func (p cellPlacement) rowEnd() int {
	return p.rowStart + p.rowSpan - 1
}

func (p cellPlacement) columnEnd() int {
	return p.columnStart + p.columnSpan - 1
}

func cellPlacements(table *docs.Table) []cellPlacement {
	if table == nil {
		return nil
	}

	covered := map[[2]int]bool{}
	placements := make([]cellPlacement, 0)

	for rowIndex, row := range table.TableRows {
		for columnIndex, cell := range row.TableCells {
			position := [2]int{rowIndex + 1, columnIndex + 1}
			if covered[position] {
				continue
			}
			placement := cellPlacement{
				rowStart:    position[0],
				columnStart: position[1],
				rowSpan:     cellRowSpan(cell),
				columnSpan:  cellColumnSpan(cell),
			}

			placements = append(placements, placement)
			for coveredRow := placement.rowStart; coveredRow <= placement.rowEnd(); coveredRow++ {
				for coveredColumn := placement.columnStart; coveredColumn <= placement.columnEnd(); coveredColumn++ {
					if coveredRow == placement.rowStart && coveredColumn == placement.columnStart {
						continue
					}
					covered[[2]int{coveredRow, coveredColumn}] = true
				}
			}
		}
	}

	return placements
}

func hasRectangularRows(table *docs.Table) bool {
	columns := ColumnCount(table)
	if table == nil || columns < 1 || len(table.TableRows) == 0 {
		return false
	}

	for _, row := range table.TableRows {
		if row == nil || len(row.TableCells) != columns {
			return false
		}
	}

	return true
}

func invalid(message string) error {
	return ValidationError(message)
}

func invalidf(format string, args ...any) error {
	return ValidationError(fmt.Sprintf(format, args...))
}
