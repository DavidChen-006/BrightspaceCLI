package docstable

import (
	"strings"
	"testing"

	"google.golang.org/api/docs/v1"
)

func TestBuildDimensionRequest(t *testing.T) {
	target := Target{
		Table:      testTable(3, 2),
		StartIndex: 5,
	}

	rowReq, rowIndex, err := BuildDimensionRequest(target, Row, Insert, 0, true, "tab-1")
	if err != nil {
		t.Fatalf("append row: %v", err)
	}

	if rowIndex != 4 {
		t.Fatalf("row index = %d, want 4", rowIndex)
	}

	row := rowReq.InsertTableRow
	if row == nil || !row.InsertBelow {
		t.Fatalf("unexpected row request: %#v", rowReq)
	}

	if got := row.TableCellLocation; got.RowIndex != 2 || got.ColumnIndex != 0 ||
		got.TableStartLocation.Index != 5 || got.TableStartLocation.TabId != "tab-1" {
		t.Fatalf("row location = %#v", got)
	}

	colReq, colIndex, err := BuildDimensionRequest(target, Column, Delete, -1, false, "")
	if err != nil {
		t.Fatalf("delete column: %v", err)
	}

	if colIndex != 2 {
		t.Fatalf("column index = %d, want 2", colIndex)
	}

	col := colReq.DeleteTableColumn
	if col == nil || col.TableCellLocation.ColumnIndex != 1 {
		t.Fatalf("unexpected column request: %#v", colReq)
	}
}

func TestBuildDimensionRequestRejectsUnknownDimension(t *testing.T) {
	_, _, err := BuildDimensionRequest(
		Target{Table: testTable(2, 2), StartIndex: 5},
		Dimension("page"),
		Insert,
		1,
		false,
		"",
	)
	if err == nil || !strings.Contains(err.Error(), `unsupported table dimension "page"`) {
		t.Fatalf("expected dimension error, got %v", err)
	}
}

func TestBuildDimensionRequestAvoidsMergedDeleteAnchor(t *testing.T) {
	table := testTable(2, 3)
	table.TableRows[0].TableCells[0].TableCellStyle = &docs.TableCellStyle{ColumnSpan: 2}

	req, _, err := BuildDimensionRequest(Target{Table: table, StartIndex: 5}, Column, Delete, 1, false, "")
	if err != nil {
		t.Fatalf("delete with safe lower-row anchor: %v", err)
	}

	if got := req.DeleteTableColumn.TableCellLocation.RowIndex; got != 1 {
		t.Fatalf("row index = %d, want safe unmerged row 1", got)
	}
}

func TestBuildDimensionRequestRejectsMergedDeleteAndInsertBoundary(t *testing.T) {
	table := testTable(2, 3)
	for _, row := range table.TableRows {
		row.TableCells[0].TableCellStyle = &docs.TableCellStyle{ColumnSpan: 2}
	}
	target := Target{Table: table, StartIndex: 5}

	if _, _, err := BuildDimensionRequest(target, Column, Delete, 1, false, ""); err == nil ||
		!strings.Contains(err.Error(), "every reference cell") {
		t.Fatalf("expected merged delete rejection, got %v", err)
	}

	if _, _, err := BuildDimensionRequest(target, Column, Insert, 2, false, ""); err == nil ||
		!strings.Contains(err.Error(), "inside merged cells") {
		t.Fatalf("expected merged insert-boundary rejection, got %v", err)
	}
}

func TestBuildDimensionRequestRejectsVerticallyMergedRow(t *testing.T) {
	table := testTable(3, 2)
	for _, cell := range table.TableRows[0].TableCells {
		cell.TableCellStyle = &docs.TableCellStyle{RowSpan: 2}
	}
	target := Target{Table: table, StartIndex: 5}

	if _, _, err := BuildDimensionRequest(target, Row, Delete, 2, false, ""); err == nil ||
		!strings.Contains(err.Error(), "every reference cell") {
		t.Fatalf("expected merged row delete rejection, got %v", err)
	}

	if _, _, err := BuildDimensionRequest(target, Row, Insert, 2, false, ""); err == nil ||
		!strings.Contains(err.Error(), "inside merged cells") {
		t.Fatalf("expected merged row insert rejection, got %v", err)
	}
}

func TestCellPlacementsSupportRetainedCoveredCells(t *testing.T) {
	retained := testTable(1, 3)
	retained.TableRows[0].TableCells[0].TableCellStyle = &docs.TableCellStyle{ColumnSpan: 2}

	placements := cellPlacements(retained)
	if len(placements) != 2 ||
		placements[0].columnStart != 1 ||
		placements[1].columnStart != 3 {
		t.Fatalf("retained placements = %#v", placements)
	}
}

func TestBuildDimensionRequestRejectsNonRectangularRows(t *testing.T) {
	table := testTable(1, 3)
	table.TableRows[0].TableCells[0].TableCellStyle = &docs.TableCellStyle{ColumnSpan: 2}
	table.TableRows[0].TableCells = []*docs.TableCell{
		table.TableRows[0].TableCells[0],
		table.TableRows[0].TableCells[2],
	}

	target := Target{Table: table, StartIndex: 5}
	if _, _, err := BuildDimensionRequest(target, Column, Delete, 3, false, ""); err == nil ||
		!strings.Contains(err.Error(), "non-rectangular") {
		t.Fatalf("expected non-rectangular rejection, got %v", err)
	}
}

func TestBuildDimensionRequestPreflightsOnlyDimension(t *testing.T) {
	rowTarget := Target{Table: testTable(1, 2), StartIndex: 5}
	if _, _, err := BuildDimensionRequest(rowTarget, Row, Delete, 1, false, ""); err == nil ||
		!strings.Contains(err.Error(), "only row") {
		t.Fatalf("expected only-row error, got %v", err)
	}

	colTarget := Target{Table: testTable(2, 1), StartIndex: 5}
	if _, _, err := BuildDimensionRequest(colTarget, Column, Delete, 1, false, ""); err == nil ||
		!strings.Contains(err.Error(), "only column") {
		t.Fatalf("expected only-column error, got %v", err)
	}
}

func TestBuildMergeRequestValidatesLogicalColumnCount(t *testing.T) {
	table := testTable(2, 2)
	table.Columns = 1

	_, err := BuildMergeRequest(Target{Table: table, StartIndex: 5}, Merge, 1, 1, 2, 2, "")
	if err == nil || !strings.Contains(err.Error(), "table has 1 columns") {
		t.Fatalf("expected logical-column validation error, got %v", err)
	}
}

func TestValidateRangeCountsMergedCellSpans(t *testing.T) {
	table := testTable(2, 3)
	table.TableRows[1].TableCells[0].TableCellStyle = &docs.TableCellStyle{ColumnSpan: 2}

	if err := ValidateRange(table, 2, 3, 2, 3); err != nil {
		t.Fatalf("validate logical third column: %v", err)
	}
}

func TestRowBoundaryCrossesMerge(t *testing.T) {
	table := testTable(3, 2)

	table.TableRows[0].TableCells[0].TableCellStyle = &docs.TableCellStyle{RowSpan: 2}
	if !RowBoundaryCrossesMerge(table, 2) {
		t.Fatal("expected merged boundary")
	}

	if RowBoundaryCrossesMerge(table, 3) {
		t.Fatal("unexpected merge at third-row boundary")
	}
}

func testTable(rows, cols int) *docs.Table {
	const header = "Header"

	next := int64(6)
	tableRows := make([]*docs.TableRow, rows)

	for row := 0; row < rows; row++ {
		cells := make([]*docs.TableCell, cols)
		for col := 0; col < cols; col++ {
			text := ""
			if row == 0 && col == 0 {
				text = header
			}
			cellStart := next
			cellEnd := cellStart + int64(len(text)) + 1
			cells[col] = &docs.TableCell{Content: []*docs.StructuralElement{{
				StartIndex: cellStart,
				EndIndex:   cellEnd,
				Paragraph: &docs.Paragraph{Elements: []*docs.ParagraphElement{{
					StartIndex: cellStart,
					EndIndex:   cellEnd,
					TextRun:    &docs.TextRun{Content: text + "\n"},
				}}},
			}}}
			next = cellEnd
		}
		tableRows[row] = &docs.TableRow{TableCells: cells}
	}

	return &docs.Table{
		Rows:      int64(rows),
		Columns:   int64(cols),
		TableRows: tableRows,
	}
}
