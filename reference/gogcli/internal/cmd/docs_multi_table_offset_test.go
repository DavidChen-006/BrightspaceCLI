package cmd

import "testing"

// Regression for #607: with three or more tables in a single markdown render
// pass, the running placeholder offset under-counted by one character per
// table, causing the trailing punctuation of the paragraph immediately before
// the third (and any subsequent) table to be re-ordered as a standalone
// paragraph after the table. The fix in nextTableInsertOffset accumulates the
// full (tableEnd - tableIndex) instead of (tableEnd - tableIndex) - 1.

func TestNextTableInsertOffset_AccumulatesFullTableSize(t *testing.T) {
	off := int64(0)

	// Table 1: spans [10, 30), size 20.
	off = nextTableInsertOffset(off, 10, 30)
	if off != 20 {
		t.Fatalf("after table 1: offset = %d, want 20", off)
	}

	// Table 2 was originally at placeholder 50; after shift it is at 50+20=70.
	// It spans [70, 90), size 20. Offset must accumulate to 40.
	off = nextTableInsertOffset(off, 70, 90)
	if off != 40 {
		t.Fatalf("after table 2: offset = %d, want 40 (previous bug: 38)", off)
	}

	// Table 3 was originally at placeholder 80; after shift it is at 80+40=120.
	// It spans [120, 135), size 15. Offset accumulates to 55.
	off = nextTableInsertOffset(off, 120, 135)
	if off != 55 {
		t.Fatalf("after table 3: offset = %d, want 55 (previous bug: 52)", off)
	}
}

func TestNextTableInsertOffset_ZeroSizedTableLeavesOffsetUnchanged(t *testing.T) {
	// If InsertNativeTable failed to grow the doc (tableEnd <= tableIndex), the
	// offset must not change so subsequent placeholders stay at their plainText
	// positions.
	if got := nextTableInsertOffset(7, 10, 10); got != 7 {
		t.Fatalf("equal indices: offset = %d, want 7 unchanged", got)
	}
	if got := nextTableInsertOffset(7, 10, 5); got != 7 {
		t.Fatalf("tableEnd < tableIndex: offset = %d, want 7 unchanged", got)
	}
}

func TestNextTableInsertOffset_MatchesIssueRepro(t *testing.T) {
	// The repro from #607 is three identical 2x2 tables interleaved with
	// paragraphs. The exact API-side table size depends on the Docs service,
	// but for ANY table size G > 0, the cumulative offset after N tables of
	// size G must equal N*G. The previous (G-1) formula produced N*(G-1),
	// undercounting by N and explaining why the corruption only became
	// visually obvious starting at the 3rd table (when drift = 2).
	const G = int64(17)
	off := int64(0)
	off = nextTableInsertOffset(off, 100, 100+G)
	off = nextTableInsertOffset(off, 200, 200+G)
	off = nextTableInsertOffset(off, 300, 300+G)
	if off != 3*G {
		t.Fatalf("3 tables of size %d: offset %d, want %d", G, off, 3*G)
	}
}
