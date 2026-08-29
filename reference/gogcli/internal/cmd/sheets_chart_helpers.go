package cmd

import (
	"google.golang.org/api/sheets/v4"
)

type chartSheetResolution struct {
	SheetID        int64
	HasSheetIDZero bool
}

func firstSheetResolution(svc *sheets.Service, spreadsheetID string) (chartSheetResolution, error) {
	resp, err := svc.Spreadsheets.Get(spreadsheetID).
		Fields("sheets(properties(sheetId,title))").
		Do()
	if err != nil {
		return chartSheetResolution{}, err
	}

	var res chartSheetResolution
	var found bool
	for _, sheet := range resp.Sheets {
		if sheet == nil || sheet.Properties == nil {
			continue
		}
		if !found {
			res.SheetID = sheet.Properties.SheetId
			found = true
		}
		if sheet.Properties.SheetId == 0 {
			res.HasSheetIDZero = true
		}
	}
	if found {
		return res, nil
	}
	return chartSheetResolution{}, usage("spreadsheet has no sheets")
}

func findChartSheetResolution(svc *sheets.Service, spreadsheetID string, chartID int64) (chartSheetResolution, error) {
	resp, err := svc.Spreadsheets.Get(spreadsheetID).
		Fields("sheets(properties(sheetId,title),charts(chartId))").
		Do()
	if err != nil {
		return chartSheetResolution{}, err
	}

	var res chartSheetResolution
	var found bool
	for _, sheet := range resp.Sheets {
		if sheet == nil || sheet.Properties == nil {
			continue
		}
		if sheet.Properties.SheetId == 0 {
			res.HasSheetIDZero = true
		}
		for _, chart := range sheet.Charts {
			if chart != nil && chart.ChartId == chartID {
				res.SheetID = sheet.Properties.SheetId
				found = true
			}
		}
	}
	if found {
		return res, nil
	}
	return chartSheetResolution{}, usagef("chart %d not found", chartID)
}

func resolveChartSheetResolution(svc *sheets.Service, spreadsheetID, sheetName string) (chartSheetResolution, error) {
	if sheetName == "" {
		return firstSheetResolution(svc, spreadsheetID)
	}

	resp, err := svc.Spreadsheets.Get(spreadsheetID).
		Fields("sheets(properties(sheetId,title))").
		Do()
	if err != nil {
		return chartSheetResolution{}, err
	}

	var res chartSheetResolution
	var found bool
	for _, sheet := range resp.Sheets {
		if sheet == nil || sheet.Properties == nil {
			continue
		}
		if sheet.Properties.SheetId == 0 {
			res.HasSheetIDZero = true
		}
		if sheet.Properties.Title == sheetName {
			res.SheetID = sheet.Properties.SheetId
			found = true
		}
	}
	if !found {
		return chartSheetResolution{}, usagef("unknown sheet %q", sheetName)
	}
	return res, nil
}
