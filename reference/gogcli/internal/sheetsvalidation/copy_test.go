package sheetsvalidation

import (
	"strings"
	"testing"

	"google.golang.org/api/sheets/v4"
)

func TestBuildCopyRequestsTilesValidation(t *testing.T) {
	rule := &sheets.DataValidationRule{
		Condition: &sheets.BooleanCondition{
			Type:   conditionOneOfList,
			Values: []*sheets.ConditionValue{{UserEnteredValue: "ready"}},
		},
		ShowCustomUi: true,
	}

	requests, err := BuildCopyRequests(
		&sheets.GridRange{
			SheetId:          1,
			StartRowIndex:    1,
			EndRowIndex:      3,
			StartColumnIndex: 0,
			EndColumnIndex:   1,
		},
		&sheets.GridRange{
			SheetId:          1,
			StartRowIndex:    5,
			EndRowIndex:      11,
			StartColumnIndex: 2,
			EndColumnIndex:   3,
		},
		false,
		[]Span{{
			SheetID:  1,
			StartRow: 1,
			EndRow:   3,
			StartCol: 0,
			EndCol:   1,
			Rule:     rule,
		}},
	)
	if err != nil {
		t.Fatalf("BuildCopyRequests() error = %v", err)
	}

	if len(requests) != 1 || requests[0].SetDataValidation == nil {
		t.Fatalf("requests = %#v", requests)
	}

	gridRange := requests[0].SetDataValidation.Range
	if gridRange.StartRowIndex != 5 || gridRange.EndRowIndex != 11 ||
		gridRange.StartColumnIndex != 2 || gridRange.EndColumnIndex != 3 {
		t.Fatalf("range = %#v", gridRange)
	}
}

func TestBuildCopyRequestsRejectsSparseExpansion(t *testing.T) {
	_, err := BuildCopyRequests(
		&sheets.GridRange{
			SheetId:          1,
			StartRowIndex:    0,
			EndRowIndex:      2,
			StartColumnIndex: 0,
			EndColumnIndex:   1,
		},
		&sheets.GridRange{
			SheetId:          1,
			StartRowIndex:    0,
			EndRowIndex:      2 * (MaxCopySegments + 1),
			StartColumnIndex: 2,
			EndColumnIndex:   3,
		},
		false,
		[]Span{{
			SheetID:  1,
			StartRow: 0,
			EndRow:   1,
			StartCol: 0,
			EndCol:   1,
			Rule: &sheets.DataValidationRule{
				Condition: &sheets.BooleanCondition{Type: conditionOneOfList},
			},
		}},
	)
	if err == nil || !strings.Contains(err.Error(), "more than 1000 supplemental ranges") {
		t.Fatalf("BuildCopyRequests() error = %v", err)
	}
}

func TestEffectiveCopyDestination(t *testing.T) {
	source := &sheets.GridRange{
		StartRowIndex:    0,
		EndRowIndex:      2,
		StartColumnIndex: 0,
		EndColumnIndex:   3,
	}
	destination := &sheets.GridRange{
		StartRowIndex:    10,
		EndRowIndex:      11,
		StartColumnIndex: 20,
		EndColumnIndex:   21,
	}

	got := EffectiveCopyDestination(source, destination, true)
	if got.StartRowIndex != 10 || got.EndRowIndex != 13 ||
		got.StartColumnIndex != 20 || got.EndColumnIndex != 22 {
		t.Fatalf("destination = %#v", got)
	}
}
