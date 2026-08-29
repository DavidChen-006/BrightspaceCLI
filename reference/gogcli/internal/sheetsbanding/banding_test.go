package sheetsbanding

import (
	"strings"
	"testing"

	"google.golang.org/api/sheets/v4"
)

func TestDecodeProperties(t *testing.T) {
	properties, err := DecodeProperties([]byte(`{"headerColorStyle":{"rgbColor":{"red":1}}}`))
	if err != nil {
		t.Fatalf("DecodeProperties() error = %v", err)
	}

	if properties.HeaderColorStyle == nil ||
		properties.HeaderColorStyle.RgbColor == nil ||
		properties.HeaderColorStyle.RgbColor.Red != 1 {
		t.Fatalf("properties = %#v", properties)
	}

	if _, err := DecodeProperties([]byte(`{"unknown":true}`)); err == nil ||
		!strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown field error = %v", err)
	}

	if _, err := DecodeProperties([]byte(`{} {}`)); err == nil ||
		!strings.Contains(err.Error(), "multiple JSON values") {
		t.Fatalf("multiple values error = %v", err)
	}
}

func TestBuildAddRequest(t *testing.T) {
	gridRange := &sheets.GridRange{SheetId: 7, EndRowIndex: 10, EndColumnIndex: 2}
	rowProperties := DefaultRowProperties()
	request := BuildAddRequest(gridRange, rowProperties, nil)

	add := request.AddBanding
	if add == nil ||
		add.BandedRange == nil ||
		add.BandedRange.Range != gridRange ||
		add.BandedRange.RowProperties != rowProperties {
		t.Fatalf("request = %#v", request)
	}
}

func TestItemsAndIDsForSheet(t *testing.T) {
	spreadsheet := &sheets.Spreadsheet{
		Sheets: []*sheets.Sheet{{
			Properties: &sheets.SheetProperties{SheetId: 7, Title: "Data Set"},
			BandedRanges: []*sheets.BandedRange{{
				BandedRangeId: 9,
				Range:         &sheets.GridRange{SheetId: 7, EndRowIndex: 10, EndColumnIndex: 2},
			}},
		}},
	}

	items := Items(spreadsheet, "")
	if len(items) != 1 ||
		items[0].BandedRangeID != 9 ||
		items[0].A1 != "'Data Set'!A1:B10" {
		t.Fatalf("items = %#v", items)
	}

	ids, found := IDsForSheet(spreadsheet, "Data Set")
	if !found || len(ids) != 1 || ids[0] != 9 {
		t.Fatalf("ids = %#v, found = %t", ids, found)
	}
}

func TestDeleteRequest(t *testing.T) {
	request := DeleteRequest(9)
	if request.DeleteBanding == nil || request.DeleteBanding.BandedRangeId != 9 {
		t.Fatalf("request = %#v", request)
	}
}
