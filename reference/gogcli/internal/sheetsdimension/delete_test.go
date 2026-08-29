package sheetsdimension

import (
	"strings"
	"testing"

	"google.golang.org/api/sheets/v4"
)

func TestPlanTableUpdates(t *testing.T) {
	table := &sheets.Table{
		TableId: "tbl1",
		Name:    "Tasks",
		Range: &sheets.GridRange{
			SheetId:          7,
			StartRowIndex:    2,
			EndRowIndex:      8,
			StartColumnIndex: 1,
			EndColumnIndex:   5,
		},
	}

	updates, err := PlanTableUpdates([]*sheets.Table{table}, 7, DeleteSpec{
		Dimension:  Columns,
		Label:      "columns",
		StartIndex: 2,
		EndIndex:   4,
	})
	if err != nil {
		t.Fatalf("PlanTableUpdates() error = %v", err)
	}

	if len(updates) != 1 {
		t.Fatalf("update count = %d, want 1", len(updates))
	}

	if updates[0].After.StartColumnIndex != 1 || updates[0].After.EndColumnIndex != 3 {
		t.Fatalf("after range = %#v", updates[0].After)
	}

	_, err = PlanTableUpdates([]*sheets.Table{table}, 7, DeleteSpec{
		Dimension:  Columns,
		Label:      "columns",
		StartIndex: 0,
		EndIndex:   5,
	})
	if err == nil || !strings.Contains(err.Error(), "entire column extent") {
		t.Fatalf("PlanTableUpdates() error = %v", err)
	}
}

func TestValidateBounds(t *testing.T) {
	spec := DeleteSpec{
		Dimension:  Rows,
		Label:      "rows",
		StartIndex: 1,
		EndIndex:   4,
	}
	if err := ValidateBounds(spec, &sheets.SheetProperties{
		GridProperties: &sheets.GridProperties{RowCount: 3, ColumnCount: 10},
	}); err == nil || !strings.Contains(err.Error(), "exceeds sheet size") {
		t.Fatalf("ValidateBounds() error = %v", err)
	}

	spec.StartIndex = 0

	spec.EndIndex = 3
	if err := ValidateBounds(spec, &sheets.SheetProperties{
		GridProperties: &sheets.GridProperties{RowCount: 3, ColumnCount: 10},
	}); err == nil || !strings.Contains(err.Error(), "cannot delete every row") {
		t.Fatalf("ValidateBounds() error = %v", err)
	}
}

func TestResizeTableRangeDoesNotMutateInput(t *testing.T) {
	before := &sheets.GridRange{
		SheetId:          0,
		StartRowIndex:    2,
		EndRowIndex:      8,
		StartColumnIndex: 1,
		EndColumnIndex:   5,
		ForceSendFields:  []string{"StartRowIndex"},
	}

	after, intersects, err := ResizeTableRange(before, DeleteSpec{
		Dimension:  Rows,
		Label:      "rows",
		StartIndex: 3,
		EndIndex:   5,
	})
	if err != nil {
		t.Fatalf("ResizeTableRange() error = %v", err)
	}

	if !intersects || after.StartRowIndex != 2 || after.EndRowIndex != 6 {
		t.Fatalf("after = %#v, intersects = %t", after, intersects)
	}

	if before.EndRowIndex != 8 || len(before.ForceSendFields) != 1 {
		t.Fatalf("input mutated: %#v", before)
	}
}
