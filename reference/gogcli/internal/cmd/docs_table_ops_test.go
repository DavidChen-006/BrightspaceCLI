package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/api/docs/v1"
)

func newDocsTableOpsTestContext(t *testing.T, svc *docs.Service) context.Context {
	t.Helper()
	return withDocsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
}

func TestResolveDocsTableSelector(t *testing.T) {
	doc := docsTableOpsTestDocument(
		docsTableOpsTestElement(5, "First", 2),
		docsTableOpsTestElement(40, "Second", 3),
	)

	tests := []struct {
		name      string
		selector  string
		wantIndex []int
	}{
		{name: "positive", selector: "1", wantIndex: []int{1}},
		{name: "negative", selector: "-1", wantIndex: []int{2}},
		{name: "header", selector: "Second", wantIndex: []int{2}},
		{name: "all", selector: "*", wantIndex: []int{1, 2}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			selected, err := resolveDocsTableSelector(doc, tt.selector)
			if err != nil {
				t.Fatalf("resolveDocsTableSelector: %v", err)
			}
			if len(selected) != len(tt.wantIndex) {
				t.Fatalf("selected = %d, want %d", len(selected), len(tt.wantIndex))
			}
			for i, want := range tt.wantIndex {
				if selected[i].index != want {
					t.Fatalf("selected[%d].index = %d, want %d", i, selected[i].index, want)
				}
			}
		})
	}
}

func TestResolveDocsTableSelectorRejectsAmbiguousHeader(t *testing.T) {
	doc := docsTableOpsTestDocument(
		docsTableOpsTestElement(5, "Same", 2),
		docsTableOpsTestElement(40, "Same", 2),
	)
	_, err := resolveDocsTableSelector(doc, "Same")
	if err == nil || !strings.Contains(err.Error(), "matches 2 tables") {
		t.Fatalf("expected ambiguity error, got %v", err)
	}
}

func TestResolveDocsTableSelectorPreservesHeaderWhitespace(t *testing.T) {
	doc := docsTableOpsTestDocument(docsTableOpsTestElement(5, " Status ", 2))
	selected, err := resolveDocsTableSelector(doc, " Status ")
	if err != nil {
		t.Fatalf("resolve exact whitespace: %v", err)
	}
	if len(selected) != 1 || selected[0].index != 1 {
		t.Fatalf("selected = %#v", selected)
	}
	if _, err := resolveDocsTableSelector(doc, "Status"); err == nil {
		t.Fatal("expected trimmed selector not to match")
	}
}

func TestResolveDocsTableSelectorSupportsNumericHeaderText(t *testing.T) {
	doc := docsTableOpsTestDocument(
		docsTableOpsTestElement(5, "First", 2),
		docsTableOpsTestElement(40, "2026", 2),
	)
	selected, err := resolveDocsTableSelector(doc, "text:2026")
	if err != nil {
		t.Fatalf("resolve numeric header: %v", err)
	}
	if len(selected) != 1 || selected[0].index != 2 {
		t.Fatalf("selected = %#v", selected)
	}
}

func TestResolveDocsTableSelectorRejectsNumericOverflow(t *testing.T) {
	const overflow = "999999999999999999999999999999"
	doc := docsTableOpsTestDocument(docsTableOpsTestElement(5, overflow, 2))
	_, err := resolveDocsTableSelector(doc, overflow)
	if err == nil || !strings.Contains(err.Error(), "invalid table index") {
		t.Fatalf("expected numeric overflow error, got %v", err)
	}
}

func TestDocsTableColumnDeleteAllUsesDescendingDocumentOrder(t *testing.T) {
	doc := docsTableOpsTestDocument(
		docsTableOpsTestElement(5, "First", 2),
		docsTableOpsTestElement(40, "Second", 2),
	)
	var got docs.BatchUpdateDocumentRequest
	docSvc, cleanup := newDocsServiceForTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(doc)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, ":batchUpdate"):
			if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
				t.Fatalf("decode batch: %v", err)
			}
			_ = json.NewEncoder(w).Encode(&docs.BatchUpdateDocumentResponse{DocumentId: "doc1"})
		default:
			http.NotFound(w, r)
		}
	})
	defer cleanup()

	cmd := &DocsTableColumnDeleteCmd{}
	err := runKong(t, cmd, []string{"doc1", "--table", "*", "--col=-1"}, newDocsTableOpsTestContext(t, docSvc), &RootFlags{Account: "a@b.com"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got.WriteControl == nil || got.WriteControl.RequiredRevisionId != "rev-1" {
		t.Fatalf("write control = %#v", got.WriteControl)
	}
	if len(got.Requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(got.Requests))
	}
	if first := got.Requests[0].DeleteTableColumn.TableCellLocation.TableStartLocation.Index; first != 40 {
		t.Fatalf("first table start = %d, want 40", first)
	}
	if second := got.Requests[1].DeleteTableColumn.TableCellLocation.TableStartLocation.Index; second != 5 {
		t.Fatalf("second table start = %d, want 5", second)
	}
}

func TestDocsTableRowInsertPopulatesValues(t *testing.T) {
	before := docsTableOpsTestDocument(docsTableOpsTestElement(5, "Header", 2))
	after := docsTableOpsTestDocument(docsTableOpsTestElement(5, "Header", 3))
	after.RevisionId = "rev-2"
	var batches []docs.BatchUpdateDocumentRequest
	gets := 0
	docSvc, cleanup := newDocsServiceForTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet:
			gets++
			if gets == 1 {
				_ = json.NewEncoder(w).Encode(before)
			} else {
				_ = json.NewEncoder(w).Encode(after)
			}
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, ":batchUpdate"):
			var batch docs.BatchUpdateDocumentRequest
			if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
				t.Fatalf("decode batch: %v", err)
			}
			batches = append(batches, batch)
			revisionID := "rev-2"
			if len(batches) > 1 {
				revisionID = "rev-3"
			}
			_ = json.NewEncoder(w).Encode(&docs.BatchUpdateDocumentResponse{
				DocumentId:   "doc1",
				WriteControl: &docs.WriteControl{RequiredRevisionId: revisionID},
			})
		default:
			http.NotFound(w, r)
		}
	})
	defer cleanup()

	cmd := &DocsTableRowInsertCmd{}
	err := runKong(t, cmd, []string{
		"doc1", "--table", "*", "--at", "end", "--values-json", `["left","right"]`,
	}, newDocsTableOpsTestContext(t, docSvc), &RootFlags{Account: "a@b.com"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(batches) != 2 {
		t.Fatalf("batches = %d, want 2", len(batches))
	}
	if batches[0].Requests[0].InsertTableRow == nil {
		t.Fatalf("first batch = %#v", batches[0].Requests)
	}
	if len(batches[1].Requests) != 2 {
		t.Fatalf("fill requests = %d, want 2", len(batches[1].Requests))
	}
	if batches[1].Requests[0].InsertText.Text != "right" || batches[1].Requests[1].InsertText.Text != "left" {
		t.Fatalf("fill request order = %#v", batches[1].Requests)
	}
	if batches[1].WriteControl == nil || batches[1].WriteControl.RequiredRevisionId != "rev-2" {
		t.Fatalf("fill write control = %#v", batches[1].WriteControl)
	}
}

func TestDocsTableRowInsertValuesRejectsMultipleSelectedTables(t *testing.T) {
	doc := docsTableOpsTestDocument(
		docsTableOpsTestElement(5, "First", 2),
		docsTableOpsTestElement(40, "Second", 2),
	)
	postCount := 0
	docSvc, cleanup := newDocsServiceForTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(doc)
			return
		}
		if r.Method == http.MethodPost {
			postCount++
		}
		http.NotFound(w, r)
	})
	defer cleanup()

	cmd := &DocsTableRowInsertCmd{}
	err := runKong(t, cmd, []string{
		"doc1", "--table", "*", "--at", "end", "--values-json", `["left","right"]`,
	}, newDocsTableOpsTestContext(t, docSvc), &RootFlags{Account: "a@b.com"})
	if err == nil || !strings.Contains(err.Error(), "exactly one selected table") {
		t.Fatalf("expected selection-count error, got %v", err)
	}
	if postCount != 0 {
		t.Fatalf("post count = %d, want 0", postCount)
	}
}

func TestDocsTableRowInsertValuesRejectsVerticalMergeBoundary(t *testing.T) {
	doc := docsTableOpsTestDocument(docsTableOpsTestElement(5, "Header", 3))
	doc.Body.Content[0].Table.TableRows[0].TableCells[0].TableCellStyle = &docs.TableCellStyle{RowSpan: 2}
	postCount := 0
	docSvc, cleanup := newDocsServiceForTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(doc)
			return
		}
		if r.Method == http.MethodPost {
			postCount++
		}
		http.NotFound(w, r)
	})
	defer cleanup()

	cmd := &DocsTableRowInsertCmd{}
	err := runKong(t, cmd, []string{
		"doc1", "--table", "1", "--at", "2", "--values-json", `["left","right"]`,
	}, newDocsTableOpsTestContext(t, docSvc), &RootFlags{Account: "a@b.com"})
	if err == nil || !strings.Contains(err.Error(), "vertically merged cell") {
		t.Fatalf("expected vertical merge boundary error, got %v", err)
	}
	if postCount != 0 {
		t.Fatalf("post count = %d, want 0", postCount)
	}
}

func TestDocsTableRowInsertValuesRejectsConcurrentRevision(t *testing.T) {
	before := docsTableOpsTestDocument(docsTableOpsTestElement(5, "Header", 2))
	after := docsTableOpsTestDocument(docsTableOpsTestElement(5, "Header", 3))
	after.RevisionId = "rev-collaborator"
	batchCount := 0
	gets := 0
	docSvc, cleanup := newDocsServiceForTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet:
			gets++
			if gets == 1 {
				_ = json.NewEncoder(w).Encode(before)
			} else {
				_ = json.NewEncoder(w).Encode(after)
			}
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, ":batchUpdate"):
			batchCount++
			_ = json.NewEncoder(w).Encode(&docs.BatchUpdateDocumentResponse{
				DocumentId:   "doc1",
				WriteControl: &docs.WriteControl{RequiredRevisionId: "rev-2"},
			})
		default:
			http.NotFound(w, r)
		}
	})
	defer cleanup()

	cmd := &DocsTableRowInsertCmd{}
	err := runKong(t, cmd, []string{
		"doc1", "--table", "1", "--at", "end", "--values-json", `["left","right"]`,
	}, newDocsTableOpsTestContext(t, docSvc), &RootFlags{Account: "a@b.com"})
	if err == nil || !strings.Contains(err.Error(), "document revision changed") {
		t.Fatalf("expected concurrent revision error, got %v", err)
	}
	if batchCount != 1 {
		t.Fatalf("batch count = %d, want structural batch only", batchCount)
	}
}

func TestParseDocsTableRowValuesRejectsNull(t *testing.T) {
	if _, err := parseDocsTableRowValues("null"); err == nil {
		t.Fatal("expected null rejection")
	}
	if _, err := parseDocsTableRowValues(`["left",null]`); err == nil || !strings.Contains(err.Error(), "element 1") {
		t.Fatalf("expected null element rejection, got %v", err)
	}
	if _, err := parseDocsTableRowValues(`["left",2]`); err == nil || !strings.Contains(err.Error(), "element 1") {
		t.Fatalf("expected numeric element rejection, got %v", err)
	}
}

func TestExecuteDocsTableRequestsSplitsAtAPICap(t *testing.T) {
	var batches []docs.BatchUpdateDocumentRequest
	docSvc, cleanup := newDocsServiceForTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var batch docs.BatchUpdateDocumentRequest
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Fatalf("decode batch: %v", err)
		}
		batches = append(batches, batch)
		revisionID := "rev-2"
		if len(batches) > 1 {
			revisionID = "rev-3"
		}
		_ = json.NewEncoder(w).Encode(&docs.BatchUpdateDocumentResponse{
			DocumentId:   "doc1",
			WriteControl: &docs.WriteControl{RequiredRevisionId: revisionID},
		})
	})
	defer cleanup()

	requests := make([]*docs.Request, docsBatchUpdateRequestCap+1)
	for i := range requests {
		requests[i] = &docs.Request{InsertTableRow: &docs.InsertTableRowRequest{}}
	}
	var diagnostics bytes.Buffer
	ctx := newCmdRuntimeOutputContext(t, io.Discard, &diagnostics)
	if _, err := executeDocsTableRequests(ctx, docSvc, "doc1", "rev-1", requests); err != nil {
		t.Fatalf("executeDocsTableRequests: %v", err)
	}
	if len(batches) != 2 || len(batches[0].Requests) != docsBatchUpdateRequestCap || len(batches[1].Requests) != 1 {
		t.Fatalf("batch sizes = %d/%d/%d", len(batches), len(batches[0].Requests), len(batches[1].Requests))
	}
	if batches[0].WriteControl == nil || batches[0].WriteControl.RequiredRevisionId != "rev-1" {
		t.Fatalf("first write control = %#v", batches[0].WriteControl)
	}
	if batches[1].WriteControl == nil || batches[1].WriteControl.RequiredRevisionId != "rev-2" {
		t.Fatalf("second write control = %#v, want rev-2", batches[1].WriteControl)
	}
	if got := diagnostics.String(); !strings.Contains(got, "docs batchUpdate split 1/2") || !strings.Contains(got, "docs batchUpdate split 2/2") {
		t.Fatalf("unexpected split diagnostics: %q", got)
	}
}

func docsTableOpsTestDocument(elements ...*docs.StructuralElement) *docs.Document {
	return &docs.Document{
		DocumentId: "doc1",
		RevisionId: "rev-1",
		Body:       &docs.Body{Content: elements},
	}
}

func docsTableOpsTestElement(start int64, header string, rows int) *docs.StructuralElement {
	const cols = 2

	next := start + 1
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
	return &docs.StructuralElement{
		StartIndex: start,
		EndIndex:   next,
		Table: &docs.Table{
			Rows:      int64(rows),
			Columns:   int64(cols),
			TableRows: tableRows,
		},
	}
}
