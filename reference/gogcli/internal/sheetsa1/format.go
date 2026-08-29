package sheetsa1

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"google.golang.org/api/sheets/v4"
)

var simpleSheetNamePattern = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

func ColumnLetters(column int) (string, error) {
	if column <= 0 {
		return "", invalidf("invalid column index %d", column)
	}

	var letters []byte

	for column > 0 {
		column--
		letters = append(letters, byte('A'+(column%26)))
		column /= 26
	}

	for left, right := 0, len(letters)-1; left < right; left, right = left+1, right-1 {
		letters[left], letters[right] = letters[right], letters[left]
	}

	return string(letters), nil
}

func SheetPrefix(sheetTitle string) string {
	if sheetTitle == "" {
		return ""
	}

	if simpleSheetNamePattern.MatchString(sheetTitle) {
		return sheetTitle + "!"
	}

	escaped := strings.ReplaceAll(sheetTitle, "'", "''")

	return "'" + escaped + "'!"
}

func FormatCell(sheetTitle string, row, column int) string {
	columnLetters, err := ColumnLetters(column)
	if err != nil || row <= 0 {
		return ""
	}

	cell := fmt.Sprintf("%s%d", columnLetters, row)
	if sheetTitle == "" {
		return cell
	}

	return SheetPrefix(sheetTitle) + cell
}

func FormatGridRange(sheetTitle string, gridRange *sheets.GridRange) string {
	if gridRange == nil {
		return ""
	}

	sheetPrefix := SheetPrefix(sheetTitle)
	if sheetPrefix == "" {
		sheetPrefix = "sheetId:" + strconv.FormatInt(gridRange.SheetId, 10) + "!"
	}

	startRowSet := gridRange.StartRowIndex > 0
	startColumnSet := gridRange.StartColumnIndex > 0
	endRowSet := gridRange.EndRowIndex > 0
	endColumnSet := gridRange.EndColumnIndex > 0

	if !startRowSet && !startColumnSet && !endRowSet && !endColumnSet {
		return strings.TrimSuffix(sheetPrefix, "!")
	}

	// Start-only GridRanges have no unambiguous A1 representation.
	if !endRowSet && !endColumnSet {
		return ""
	}

	startRow := gridRange.StartRowIndex + 1
	endRow := gridRange.EndRowIndex
	startColumn := gridRange.StartColumnIndex + 1
	endColumn := gridRange.EndColumnIndex

	if endColumnSet && !endRowSet {
		startLetters, err := ColumnLetters(int(startColumn))
		if err != nil {
			return ""
		}

		endLetters, err := ColumnLetters(int(endColumn))
		if err != nil {
			return ""
		}

		if gridRange.StartRowIndex > 0 {
			return fmt.Sprintf("%s%s%d:%s", sheetPrefix, startLetters, startRow, endLetters)
		}

		return fmt.Sprintf("%s%s:%s", sheetPrefix, startLetters, endLetters)
	}

	if endRowSet && !endColumnSet {
		if gridRange.StartColumnIndex > 0 {
			return ""
		}

		return fmt.Sprintf("%s%d:%d", sheetPrefix, startRow, endRow)
	}

	startLetters, err := ColumnLetters(int(startColumn))
	if err != nil {
		return ""
	}

	endLetters, err := ColumnLetters(int(endColumn))
	if err != nil {
		return ""
	}

	startCell := fmt.Sprintf("%s%d", startLetters, startRow)

	endCell := fmt.Sprintf("%s%d", endLetters, endRow)
	if startCell == endCell {
		return sheetPrefix + startCell
	}

	return fmt.Sprintf("%s%s:%s", sheetPrefix, startCell, endCell)
}
