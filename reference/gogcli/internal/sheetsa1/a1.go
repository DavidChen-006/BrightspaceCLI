package sheetsa1

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type ValidationError string

func (e ValidationError) Error() string {
	return string(e)
}

type Range struct {
	SheetName        string
	StartRow, EndRow int
	StartCol, EndCol int
}

var (
	cellPattern = regexp.MustCompile(`^([A-Za-z]+)([0-9]+)$`)
	colPattern  = regexp.MustCompile(`^([A-Za-z]+)$`)
	rowPattern  = regexp.MustCompile(`^([0-9]+)$`)
)

func Parse(input string) (Range, error) {
	raw := strings.TrimSpace(input)
	if raw == "" {
		return Range{}, invalid("empty A1 range")
	}

	raw = strings.TrimPrefix(raw, "range=")

	sheetName, rangePart, err := Split(raw)
	if err != nil {
		return Range{}, err
	}

	if strings.TrimSpace(rangePart) == "" {
		return Range{}, invalidf("missing range in %q", raw)
	}

	rangePart = strings.ReplaceAll(rangePart, "$", "")

	parts := strings.Split(rangePart, ":")
	if len(parts) > 2 {
		return Range{}, invalidf("invalid A1 range %q", raw)
	}

	startRef := strings.TrimSpace(parts[0])

	endRef := startRef
	if len(parts) == 2 {
		endRef = strings.TrimSpace(parts[1])
	}

	type refKind int
	const (
		refUnknown refKind = iota
		refCell
		refCol
		refRow
	)

	parseRef := func(ref string) (kind refKind, col int, row int, err error) {
		if strings.TrimSpace(ref) == "" {
			return refUnknown, 0, 0, invalid("empty A1 ref")
		}

		if match := cellPattern.FindStringSubmatch(ref); match != nil {
			column, err := ColumnIndex(match[1])
			if err != nil {
				return refUnknown, 0, 0, err
			}

			row, err := strconv.Atoi(match[2])
			if err != nil || row <= 0 {
				return refUnknown, 0, 0, invalidf("invalid row in %q", ref)
			}

			return refCell, column, row, nil
		}

		if match := colPattern.FindStringSubmatch(ref); match != nil {
			column, err := ColumnIndex(match[1])
			if err != nil {
				return refUnknown, 0, 0, err
			}

			return refCol, column, 0, nil
		}

		if match := rowPattern.FindStringSubmatch(ref); match != nil {
			row, err := strconv.Atoi(match[1])
			if err != nil || row <= 0 {
				return refUnknown, 0, 0, invalidf("invalid row in %q", ref)
			}

			return refRow, 0, row, nil
		}

		return refUnknown, 0, 0, invalidf("invalid A1 ref %q", ref)
	}

	startKind, startCol, startRow, err := parseRef(startRef)
	if err != nil {
		return Range{}, err
	}

	endKind, endCol, endRow, err := parseRef(endRef)
	if err != nil {
		return Range{}, err
	}

	if len(parts) == 1 && startKind != refCell {
		return Range{}, invalidf("invalid A1 range %q", raw)
	}

	switch startKind {
	case refCell:
		switch endKind {
		case refCell:
		case refCol:
			endRow = 0
		default:
			return Range{}, invalidf("invalid A1 range %q", raw)
		}
	case refCol:
		switch endKind {
		case refCol:
			startRow, endRow = 0, 0
		default:
			return Range{}, invalidf("invalid A1 range %q", raw)
		}
	case refRow:
		switch endKind {
		case refRow:
			startCol, endCol = 0, 0
		default:
			return Range{}, invalidf("invalid A1 range %q", raw)
		}
	default:
		return Range{}, invalidf("invalid A1 range %q", raw)
	}

	if startRow > 0 && endRow > 0 && endRow < startRow {
		startRow, endRow = endRow, startRow
	}

	if startCol > 0 && endCol > 0 && endCol < startCol {
		startCol, endCol = endCol, startCol
	}

	return Range{
		SheetName: sheetName,
		StartRow:  startRow,
		EndRow:    endRow,
		StartCol:  startCol,
		EndCol:    endCol,
	}, nil
}

func Split(input string) (string, string, error) {
	idx := strings.LastIndex(input, "!")
	if idx == -1 {
		return "", input, nil
	}

	sheetPart := strings.TrimSpace(input[:idx])

	rangePart := strings.TrimSpace(input[idx+1:])
	if sheetPart == "" || rangePart == "" {
		return "", "", invalidf("invalid A1 range %q", input)
	}

	sheetName, err := unquoteSheetName(sheetPart)
	if err != nil {
		return "", "", err
	}

	return sheetName, rangePart, nil
}

func ColumnIndex(letters string) (int, error) {
	letters = strings.ToUpper(strings.TrimSpace(letters))
	if letters == "" {
		return 0, invalid("empty column")
	}

	column := 0
	maxInt := int(^uint(0) >> 1)

	for i := 0; i < len(letters); i++ {
		character := letters[i]
		if character < 'A' || character > 'Z' {
			return 0, invalidf("invalid column %q", letters)
		}

		digit := int(character - 'A' + 1)
		if column > (maxInt-digit)/26 {
			return 0, invalidf("column %q is too large", letters)
		}
		column = column*26 + digit
	}

	return column, nil
}

func unquoteSheetName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", invalid("empty sheet name")
	}

	if strings.HasPrefix(name, "'") {
		if !strings.HasSuffix(name, "'") || len(name) < 2 {
			return "", invalidf("invalid sheet name %q", name)
		}
		inner := name[1 : len(name)-1]

		return strings.ReplaceAll(inner, "''", "'"), nil
	}

	return name, nil
}

func invalid(message string) error {
	return ValidationError(message)
}

func invalidf(format string, args ...any) error {
	return ValidationError(fmt.Sprintf(format, args...))
}
