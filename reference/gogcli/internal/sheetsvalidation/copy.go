package sheetsvalidation

import (
	"encoding/json"
	"fmt"
	"sort"

	"google.golang.org/api/sheets/v4"
)

type copySegment struct {
	StartRow int64
	EndRow   int64
	StartCol int64
	EndCol   int64
	RuleKey  string
	Rule     *sheets.DataValidationRule
}

const MaxCopySegments = 1000

type CopyOptions struct {
	OrdinarySourceValidationKnown bool
	OrdinaryValidatedCells        []CellCoordinate
}

type CellCoordinate struct {
	Row int64
	Col int64
}

func BuildCopyRequests(
	source, destination *sheets.GridRange,
	transpose bool,
	spans []Span,
	options ...CopyOptions,
) ([]*sheets.Request, error) {
	if source == nil || destination == nil ||
		source.EndRowIndex <= source.StartRowIndex || source.EndColumnIndex <= source.StartColumnIndex ||
		destination.EndRowIndex <= destination.StartRowIndex || destination.EndColumnIndex <= destination.StartColumnIndex {
		return nil, nil
	}

	destination = EffectiveCopyDestination(source, destination, transpose)
	sourceSpans := RelevantSourceSpans(source, spans)
	ordinarySourceRanges := SubtractSpans(source, sourceSpans)
	destinationSpan, hasDestinationTable := FirstIntersectingSpan(destination, spans)

	opts := CopyOptions{}
	if len(options) > 0 {
		opts = options[0]
	}

	if hasDestinationTable && len(ordinarySourceRanges) > 0 {
		if !opts.OrdinarySourceValidationKnown {
			return nil, invalidf(
				"copying validation into table column %d in table %s requires a table-column source",
				destinationSpan.ColumnIndex+1,
				destinationSpan.TableID,
			)
		}

		for _, candidate := range spans {
			if spanIntersects(destination, candidate) &&
				ordinaryValidationMapsToSpan(
					source,
					destination,
					transpose,
					opts.OrdinaryValidatedCells,
					ordinarySourceRanges,
					candidate,
				) {
				return nil, invalidf(
					"copying ordinary cell validation into table column %d in table %s is not supported",
					candidate.ColumnIndex+1,
					candidate.TableID,
				)
			}
		}
	}

	if len(sourceSpans) == 0 && !hasDestinationTable {
		return nil, nil
	}

	merged := []copySegment{}

	if len(sourceSpans) > 0 {
		segments, err := buildCopySegments(source, destination, transpose, sourceSpans)
		if err != nil {
			return nil, err
		}
		merged = mergeCopySegments(segments)
	}

	coverageSegments := append([]copySegment(nil), merged...)

	if hasDestinationTable && len(ordinarySourceRanges) > 0 {
		ordinarySpans := make([]Span, 0, len(ordinarySourceRanges))
		for _, ordinaryRange := range ordinarySourceRanges {
			ordinarySpans = append(ordinarySpans, Span{
				SheetID:  ordinaryRange.SheetId,
				StartRow: ordinaryRange.StartRowIndex,
				EndRow:   ordinaryRange.EndRowIndex,
				StartCol: ordinaryRange.StartColumnIndex,
				EndCol:   ordinaryRange.EndColumnIndex,
			})
		}

		ordinarySegments, err := buildCopySegments(
			source,
			destination,
			transpose,
			ordinarySpans,
		)
		if err != nil {
			return nil, err
		}
		coverageSegments = mergeCopySegments(append(coverageSegments, ordinarySegments...))
	}

	tableRequests := []*sheets.Request{}
	protectedSpans := []Span{}

	if hasDestinationTable {
		var err error

		tableRequests, protectedSpans, err = buildDestinationCopyRequests(
			destination,
			spans,
			coverageSegments,
		)
		if err != nil {
			return nil, err
		}
	}

	requests := append([]*sheets.Request(nil), tableRequests...)

	for _, segment := range merged {
		ranges := []*sheets.GridRange{{
			SheetId:          destination.SheetId,
			StartRowIndex:    segment.StartRow,
			EndRowIndex:      segment.EndRow,
			StartColumnIndex: segment.StartCol,
			EndColumnIndex:   segment.EndCol,
			ForceSendFields:  []string{"SheetId"},
		}}
		for _, span := range protectedSpans {
			cut := &sheets.GridRange{
				SheetId:          span.SheetID,
				StartRowIndex:    span.StartRow,
				EndRowIndex:      span.EndRow,
				StartColumnIndex: span.StartCol,
				EndColumnIndex:   span.EndCol,
			}

			next := make([]*sheets.GridRange, 0, len(ranges)+3)
			for _, current := range ranges {
				next = append(next, SubtractRange(current, cut)...)
			}
			ranges = next
		}

		for _, gridRange := range ranges {
			requests = append(requests, &sheets.Request{
				SetDataValidation: &sheets.SetDataValidationRequest{
					Range:                gridRange,
					Rule:                 segment.Rule,
					FilteredRowsIncluded: true,
					ForceSendFields:      []string{"FilteredRowsIncluded"},
				},
			})
		}
	}

	return requests, nil
}

func FirstIntersectingSpan(target *sheets.GridRange, spans []Span) (Span, bool) {
	if target == nil {
		return Span{}, false
	}

	for _, span := range spans {
		if spanIntersects(target, span) {
			return span, true
		}
	}

	return Span{}, false
}

func ordinaryValidationMapsToSpan(
	source, destination *sheets.GridRange,
	transpose bool,
	validatedCells []CellCoordinate,
	ordinarySourceRanges []*sheets.GridRange,
	span Span,
) bool {
	if source == nil || destination == nil || !spanIntersects(destination, span) {
		return false
	}
	startRow, endRow, _ := IntersectGridIndexes(
		span.StartRow,
		span.EndRow,
		destination.StartRowIndex,
		destination.EndRowIndex,
	)
	startCol, endCol, _ := IntersectGridIndexes(
		span.StartCol,
		span.EndCol,
		destination.StartColumnIndex,
		destination.EndColumnIndex,
	)
	patternHeight := source.EndRowIndex - source.StartRowIndex

	patternWidth := source.EndColumnIndex - source.StartColumnIndex
	if transpose {
		patternHeight, patternWidth = patternWidth, patternHeight
	}

	for _, cell := range validatedCells {
		if !rangesContainCell(ordinarySourceRanges, source.SheetId, cell.Row, cell.Col) {
			continue
		}
		rowOffset := cell.Row - source.StartRowIndex

		colOffset := cell.Col - source.StartColumnIndex
		if transpose {
			rowOffset, colOffset = colOffset, rowOffset
		}

		if repeatingOffsetIntersects(
			destination.StartRowIndex+rowOffset,
			patternHeight,
			startRow,
			endRow,
		) && repeatingOffsetIntersects(
			destination.StartColumnIndex+colOffset,
			patternWidth,
			startCol,
			endCol,
		) {
			return true
		}
	}

	return false
}

func rangesContainCell(ranges []*sheets.GridRange, sheetID, row, col int64) bool {
	for _, gridRange := range ranges {
		if gridRange != nil &&
			gridRange.SheetId == sheetID &&
			row >= gridRange.StartRowIndex && row < gridRange.EndRowIndex &&
			col >= gridRange.StartColumnIndex && col < gridRange.EndColumnIndex {
			return true
		}
	}

	return false
}

func repeatingOffsetIntersects(base, step, start, end int64) bool {
	if step <= 0 || end <= start || base >= end {
		return false
	}

	if base < start {
		base += ((start - base + step - 1) / step) * step
	}

	return base < end
}

func spanIntersects(target *sheets.GridRange, span Span) bool {
	if target == nil || span.SheetID != target.SheetId {
		return false
	}

	if _, _, ok := IntersectGridIndexes(
		span.StartRow,
		span.EndRow,
		target.StartRowIndex,
		target.EndRowIndex,
	); !ok {
		return false
	}
	_, _, ok := IntersectGridIndexes(
		span.StartCol,
		span.EndCol,
		target.StartColumnIndex,
		target.EndColumnIndex,
	)

	return ok
}

func RelevantSourceSpans(source *sheets.GridRange, spans []Span) []Span {
	relevant := make([]Span, 0)

	for _, span := range spans {
		if span.SheetID != source.SheetId {
			continue
		}
		startRow, endRow, rowsOK := IntersectGridIndexes(
			span.StartRow,
			span.EndRow,
			source.StartRowIndex,
			source.EndRowIndex,
		)

		startCol, endCol, colsOK := IntersectGridIndexes(
			span.StartCol,
			span.EndCol,
			source.StartColumnIndex,
			source.EndColumnIndex,
		)
		if !rowsOK || !colsOK {
			continue
		}
		clipped := span
		clipped.StartRow = startRow
		clipped.EndRow = endRow
		clipped.StartCol = startCol
		clipped.EndCol = endCol
		relevant = append(relevant, clipped)
	}

	return relevant
}

func buildCopySegments(
	source, destination *sheets.GridRange,
	transpose bool,
	spans []Span,
) ([]copySegment, error) {
	sourceHeight := source.EndRowIndex - source.StartRowIndex
	sourceWidth := source.EndColumnIndex - source.StartColumnIndex

	patternHeight, patternWidth := sourceHeight, sourceWidth
	if transpose {
		patternHeight, patternWidth = sourceWidth, sourceHeight
	}
	rowTiles := (destination.EndRowIndex - destination.StartRowIndex) / patternHeight
	colTiles := (destination.EndColumnIndex - destination.StartColumnIndex) / patternWidth

	patternSegments := make([]copySegment, 0, len(spans))
	for _, span := range spans {
		ruleKey, err := ruleKeyForValidation(span.Rule)
		if err != nil {
			return nil, err
		}

		patternSegments = append(patternSegments, copySegment{
			StartRow: span.StartRow,
			EndRow:   span.EndRow,
			StartCol: span.StartCol,
			EndCol:   span.EndCol,
			RuleKey:  ruleKey,
			Rule:     span.Rule,
		})
	}
	patternSegments = mergeCopySegments(patternSegments)

	segments := make([]copySegment, 0, len(patternSegments))
	var err error

	for _, patternSegment := range patternSegments {
		relRowStart := patternSegment.StartRow - source.StartRowIndex
		relRowEnd := patternSegment.EndRow - source.StartRowIndex
		relColStart := patternSegment.StartCol - source.StartColumnIndex
		relColEnd := patternSegment.EndCol - source.StartColumnIndex
		mappedRowStart, mappedRowEnd := relRowStart, relRowEnd

		mappedColStart, mappedColEnd := relColStart, relColEnd
		if transpose {
			mappedRowStart, mappedRowEnd = relColStart, relColEnd
			mappedColStart, mappedColEnd = relRowStart, relRowEnd
		}
		fullRows := mappedRowStart == 0 && mappedRowEnd == patternHeight

		fullCols := mappedColStart == 0 && mappedColEnd == patternWidth
		if fullRows && fullCols {
			segments, err = appendCopySegment(segments, copySegment{
				StartRow: destination.StartRowIndex,
				EndRow:   destination.EndRowIndex,
				StartCol: destination.StartColumnIndex,
				EndCol:   destination.EndColumnIndex,
				RuleKey:  patternSegment.RuleKey,
				Rule:     patternSegment.Rule,
			})
			if err != nil {
				return nil, err
			}

			continue
		}

		if fullRows {
			for colTile := int64(0); colTile < colTiles; colTile++ {
				segments, err = appendCopySegment(segments, copySegment{
					StartRow: destination.StartRowIndex,
					EndRow:   destination.EndRowIndex,
					StartCol: destination.StartColumnIndex + colTile*patternWidth + mappedColStart,
					EndCol:   destination.StartColumnIndex + colTile*patternWidth + mappedColEnd,
					RuleKey:  patternSegment.RuleKey,
					Rule:     patternSegment.Rule,
				})
				if err != nil {
					return nil, err
				}
			}

			continue
		}

		if fullCols {
			for rowTile := int64(0); rowTile < rowTiles; rowTile++ {
				segments, err = appendCopySegment(segments, copySegment{
					StartRow: destination.StartRowIndex + rowTile*patternHeight + mappedRowStart,
					EndRow:   destination.StartRowIndex + rowTile*patternHeight + mappedRowEnd,
					StartCol: destination.StartColumnIndex,
					EndCol:   destination.EndColumnIndex,
					RuleKey:  patternSegment.RuleKey,
					Rule:     patternSegment.Rule,
				})
				if err != nil {
					return nil, err
				}
			}

			continue
		}

		for rowTile := int64(0); rowTile < rowTiles; rowTile++ {
			for colTile := int64(0); colTile < colTiles; colTile++ {
				segment := copySegment{
					StartRow: destination.StartRowIndex + rowTile*patternHeight + mappedRowStart,
					EndRow:   destination.StartRowIndex + rowTile*patternHeight + mappedRowEnd,
					StartCol: destination.StartColumnIndex + colTile*patternWidth + mappedColStart,
					EndCol:   destination.StartColumnIndex + colTile*patternWidth + mappedColEnd,
					RuleKey:  patternSegment.RuleKey,
					Rule:     patternSegment.Rule,
				}

				segments, err = appendCopySegment(segments, segment)
				if err != nil {
					return nil, err
				}
			}
		}
	}

	return segments, nil
}

func appendCopySegment(segments []copySegment, segment copySegment) ([]copySegment, error) {
	if len(segments) >= MaxCopySegments {
		return nil, invalidf(
			"copying table-managed validation requires more than %d supplemental ranges; narrow the destination or copy one source footprint",
			MaxCopySegments,
		)
	}

	return append(segments, segment), nil
}

func mergeCopySegments(segments []copySegment) []copySegment {
	sort.Slice(segments, func(i, j int) bool {
		if segments[i].StartCol != segments[j].StartCol {
			return segments[i].StartCol < segments[j].StartCol
		}

		if segments[i].EndCol != segments[j].EndCol {
			return segments[i].EndCol < segments[j].EndCol
		}

		if segments[i].RuleKey != segments[j].RuleKey {
			return segments[i].RuleKey < segments[j].RuleKey
		}

		return segments[i].StartRow < segments[j].StartRow
	})

	vertical := make([]copySegment, 0, len(segments))
	for _, segment := range segments {
		last := len(vertical) - 1
		if last >= 0 &&
			vertical[last].StartCol == segment.StartCol &&
			vertical[last].EndCol == segment.EndCol &&
			vertical[last].RuleKey == segment.RuleKey &&
			vertical[last].EndRow == segment.StartRow {
			vertical[last].EndRow = segment.EndRow
			continue
		}
		vertical = append(vertical, segment)
	}

	sort.Slice(vertical, func(i, j int) bool {
		if vertical[i].StartRow != vertical[j].StartRow {
			return vertical[i].StartRow < vertical[j].StartRow
		}

		if vertical[i].EndRow != vertical[j].EndRow {
			return vertical[i].EndRow < vertical[j].EndRow
		}

		if vertical[i].RuleKey != vertical[j].RuleKey {
			return vertical[i].RuleKey < vertical[j].RuleKey
		}

		return vertical[i].StartCol < vertical[j].StartCol
	})

	merged := make([]copySegment, 0, len(vertical))
	for _, segment := range vertical {
		last := len(merged) - 1
		if last >= 0 &&
			merged[last].StartRow == segment.StartRow &&
			merged[last].EndRow == segment.EndRow &&
			merged[last].RuleKey == segment.RuleKey &&
			merged[last].EndCol == segment.StartCol {
			merged[last].EndCol = segment.EndCol
			continue
		}
		merged = append(merged, segment)
	}

	return merged
}

func buildDestinationCopyRequests(
	destination *sheets.GridRange,
	spans []Span,
	segments []copySegment,
) ([]*sheets.Request, []Span, error) {
	type copyGroup struct {
		columns    []*sheets.TableColumnProperties
		conditions map[int64]*sheets.BooleanCondition
	}
	groups := make(map[string]*copyGroup)
	protected := make([]Span, 0)

	for _, span := range spans {
		if span.SheetID != destination.SheetId {
			continue
		}

		if _, _, ok := IntersectGridIndexes(
			span.StartRow,
			span.EndRow,
			destination.StartRowIndex,
			destination.EndRowIndex,
		); !ok {
			continue
		}

		if _, _, ok := IntersectGridIndexes(
			span.StartCol,
			span.EndCol,
			destination.StartColumnIndex,
			destination.EndColumnIndex,
		); !ok {
			continue
		}
		startRow, endRow, _ := IntersectGridIndexes(
			span.StartRow,
			span.EndRow,
			destination.StartRowIndex,
			destination.EndRowIndex,
		)
		startCol, endCol, _ := IntersectGridIndexes(
			span.StartCol,
			span.EndCol,
			destination.StartColumnIndex,
			destination.EndColumnIndex,
		)

		condition, ruleKey, covered := ruleCoverage(
			segments,
			startRow,
			endRow,
			startCol,
			endCol,
		)
		if !covered {
			return nil, nil, invalidf(
				"copy into table column %d in table %s requires a table-column source covering the destination",
				span.ColumnIndex+1,
				span.TableID,
			)
		}

		existingKey, err := ruleKeyForValidation(span.Rule)
		if err != nil {
			return nil, nil, err
		}

		if ruleKey == existingKey {
			protected = append(protected, span)
			continue
		}

		if !GridRangeCoversSpan(destination, span) {
			return nil, nil, invalidf(
				"copy destination partially intersects table-managed dropdown column %d in table %s with a different rule",
				span.ColumnIndex+1,
				span.TableID,
			)
		}

		group := groups[span.TableID]
		if group == nil {
			group = &copyGroup{
				columns:    span.Columns,
				conditions: make(map[int64]*sheets.BooleanCondition),
			}
			groups[span.TableID] = group
		}
		group.conditions[span.ColumnIndex] = condition
		protected = append(protected, span)
	}

	tableIDs := make([]string, 0, len(groups))
	for tableID := range groups {
		tableIDs = append(tableIDs, tableID)
	}

	sort.Strings(tableIDs)

	requests := make([]*sheets.Request, 0, len(tableIDs))
	for _, tableID := range tableIDs {
		group := groups[tableID]
		requests = append(requests, &sheets.Request{
			UpdateTable: &sheets.UpdateTableRequest{
				Table: &sheets.Table{
					TableId: tableID,
					ColumnProperties: CloneTableColumnPropertiesWithConditions(
						group.columns,
						group.conditions,
					),
				},
				Fields: "columnProperties",
			},
		})
	}

	return requests, protected, nil
}

func ruleCoverage(
	segments []copySegment,
	startRow, endRow, startCol, endCol int64,
) (*sheets.BooleanCondition, string, bool) {
	if endRow <= startRow || endCol <= startCol {
		return nil, "", false
	}
	type interval struct {
		start int64
		end   int64
		key   string
		rule  *sheets.DataValidationRule
	}
	expectedKey := ""
	haveExpectedKey := false
	var expectedCondition *sheets.BooleanCondition

	for col := startCol; col < endCol; col++ {
		intervals := make([]interval, 0)

		for _, segment := range segments {
			if col < segment.StartCol || col >= segment.EndCol {
				continue
			}
			overlapStart := max(startRow, segment.StartRow)

			overlapEnd := min(endRow, segment.EndRow)
			if overlapEnd > overlapStart {
				intervals = append(intervals, interval{
					start: overlapStart,
					end:   overlapEnd,
					key:   segment.RuleKey,
					rule:  segment.Rule,
				})
			}
		}

		sort.Slice(intervals, func(i, j int) bool { return intervals[i].start < intervals[j].start })
		cursor := startRow
		ruleKey := ""
		haveRuleKey := false
		var condition *sheets.BooleanCondition

		for _, item := range intervals {
			if item.start > cursor {
				return nil, "", false
			}

			if item.end <= cursor {
				continue
			}

			if !haveRuleKey {
				ruleKey = item.key
				haveRuleKey = true

				if item.rule != nil {
					condition = item.rule.Condition
				}
			} else if item.key != ruleKey {
				return nil, "", false
			}

			cursor = item.end
			if cursor >= endRow {
				break
			}
		}

		if cursor < endRow {
			return nil, "", false
		}

		if !haveExpectedKey {
			expectedKey = ruleKey
			haveExpectedKey = true
			expectedCondition = condition
		} else if ruleKey != expectedKey {
			return nil, "", false
		}
	}

	return expectedCondition, expectedKey, haveExpectedKey
}

func ruleKeyForValidation(rule *sheets.DataValidationRule) (string, error) {
	if rule == nil || rule.Condition == nil {
		return "", nil
	}

	encoded, err := json.Marshal(rule)
	if err != nil {
		return "", fmt.Errorf("encode validation rule: %w", err)
	}

	return string(encoded), nil
}

func EffectiveCopyDestination(source, destination *sheets.GridRange, transpose bool) *sheets.GridRange {
	if source == nil || destination == nil {
		return destination
	}
	minHeight := source.EndRowIndex - source.StartRowIndex

	minWidth := source.EndColumnIndex - source.StartColumnIndex
	if transpose {
		minHeight, minWidth = minWidth, minHeight
	}
	effective := *destination
	effective.EndRowIndex = effective.StartRowIndex + effectivePasteLength(
		minHeight,
		effective.EndRowIndex-effective.StartRowIndex,
	)
	effective.EndColumnIndex = effective.StartColumnIndex + effectivePasteLength(
		minWidth,
		effective.EndColumnIndex-effective.StartColumnIndex,
	)

	return &effective
}

func effectivePasteLength(sourceLength, destinationLength int64) int64 {
	if destinationLength >= sourceLength && destinationLength%sourceLength == 0 {
		return destinationLength
	}

	return sourceLength
}
