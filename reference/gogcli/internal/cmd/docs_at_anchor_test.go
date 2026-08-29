package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/api/docs/v1"
)

type docsAtAnchorRecorder struct {
	batchBodies   []docs.BatchUpdateDocumentRequest
	batchRequests [][]*docs.Request
	getCalls      int
}

func setupDocsAtAnchorTestService(t *testing.T, doc *docs.Document, rec *docsAtAnchorRecorder) *docs.Service {
	t.Helper()

	docSvc, cleanup := newDocsServiceForTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/documents/"):
			rec.getCalls++
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(doc)
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, ":batchUpdate"):
			var req docs.BatchUpdateDocumentRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode batch: %v", err)
			}
			rec.batchBodies = append(rec.batchBodies, req)
			rec.batchRequests = append(rec.batchRequests, req.Requests)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"documentId": "doc1"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(cleanup)
	return docSvc
}

func TestDocsMutatorsAtAnchorResolveRange(t *testing.T) {
	t.Parallel()

	rec := &docsAtAnchorRecorder{}
	doc := docsFindRangeDoc(
		docsFindRangeParagraph(1, "Alpha target beta target\n"),
	)
	doc.RevisionId = "rev-anchor"
	svc := setupDocsAtAnchorTestService(t, doc, rec)

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withDocsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	if err := runKong(t, &DocsInsertCmd{}, []string{"doc1", "X", "--at", "target", "--occurrence", "2"}, ctx, flags); err != nil {
		t.Fatalf("insert --at: %v", err)
	}
	if got := rec.batchRequests[0][0].InsertText.Location; got.Index != 19 {
		t.Fatalf("insert location = %#v, want index 19", got)
	}
	assertDocsAtAnchorWriteControl(t, rec, 0, "rev-anchor")

	if err := runKong(t, &DocsDeleteCmd{}, []string{"doc1", "--at", "target", "--occurrence", "1"}, ctx, flags); err != nil {
		t.Fatalf("delete --at: %v", err)
	}
	if got := rec.batchRequests[1][0].DeleteContentRange.Range; got.StartIndex != 7 || got.EndIndex != 13 {
		t.Fatalf("delete range = %#v, want 7:13", got)
	}
	assertDocsAtAnchorWriteControl(t, rec, 1, "rev-anchor")

	if err := runKong(t, &DocsUpdateCmd{}, []string{"doc1", "--text", "Y", "--at", "target", "--occurrence", "2"}, ctx, flags); err != nil {
		t.Fatalf("update --at: %v", err)
	}
	reqs := rec.batchRequests[2]
	if len(reqs) != 2 || reqs[0].DeleteContentRange == nil || reqs[1].InsertText == nil {
		t.Fatalf("update requests = %#v, want delete+insert", reqs)
	}
	if got := reqs[0].DeleteContentRange.Range; got.StartIndex != 19 || got.EndIndex != 25 {
		t.Fatalf("update delete range = %#v, want 19:25", got)
	}
	if got := reqs[1].InsertText; got.Location.Index != 19 || got.Text != "Y" {
		t.Fatalf("update insert = %#v, want index 19 text Y", got)
	}
	assertDocsAtAnchorWriteControl(t, rec, 2, "rev-anchor")

	if err := runKong(t, &DocsInsertPageBreakCmd{}, []string{"doc1", "--at", "target", "--occurrence", "1"}, ctx, flags); err != nil {
		t.Fatalf("insert-page-break --at: %v", err)
	}
	if got := rec.batchRequests[3][0].InsertPageBreak.Location; got.Index != 7 {
		t.Fatalf("page break location = %#v, want index 7", got)
	}
	assertDocsAtAnchorWriteControl(t, rec, 3, "rev-anchor")
}

func TestDocsInsertPersonAtAnchorIsAtomic(t *testing.T) {
	t.Parallel()

	rec := &docsAtAnchorRecorder{}
	doc := docsFindRangeDoc(
		docsFindRangeParagraph(1, "Replace target now\n"),
	)
	doc.RevisionId = "rev-person"
	svc := setupDocsAtAnchorTestService(t, doc, rec)

	ctx := withDocsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	if err := runKong(t, &DocsInsertPersonCmd{}, []string{"doc1", "--email", "bot@example.com", "--at", "target"}, ctx, &RootFlags{Account: "a@b.com"}); err != nil {
		t.Fatalf("insert-person --at: %v", err)
	}

	if len(rec.batchRequests) != 1 {
		t.Fatalf("batch calls = %d, want one atomic call", len(rec.batchRequests))
	}
	reqs := rec.batchRequests[0]
	if len(reqs) != 2 || reqs[0].DeleteContentRange == nil || reqs[1].InsertPerson == nil {
		t.Fatalf("requests = %#v, want delete+insert-person", reqs)
	}
	if got := reqs[0].DeleteContentRange.Range; got.StartIndex != 9 || got.EndIndex != 15 {
		t.Fatalf("delete range = %#v, want 9:15", got)
	}
	person := reqs[1].InsertPerson
	if person.Location.Index != 9 || person.PersonProperties.Email != "bot@example.com" {
		t.Fatalf("insert person = %#v", person)
	}
	assertDocsAtAnchorWriteControl(t, rec, 0, "rev-person")
}

func TestDocsAtAnchorLiteralWhitespace(t *testing.T) {
	t.Parallel()

	rec := &docsAtAnchorRecorder{}
	svc := setupDocsAtAnchorTestService(t, docsFindRangeDoc(
		docsFindRangeParagraph(1, "foo  bar\n"),
	), rec)

	ctx := withDocsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	flags := &RootFlags{Account: "a@b.com"}

	err := runKong(t, &DocsInsertCmd{}, []string{"doc1", "X", "--at", "foo bar"}, ctx, flags)
	if err == nil || ExitCode(err) != emptyResultsExitCode {
		t.Fatalf("collapsed whitespace error = %v, exit=%d, want empty results", err, ExitCode(err))
	}
	if len(rec.batchRequests) != 0 {
		t.Fatalf("collapsed whitespace anchor mutated: %#v", rec.batchRequests)
	}

	if err := runKong(t, &DocsInsertCmd{}, []string{"doc1", "X", "--at", "foo  bar"}, ctx, flags); err != nil {
		t.Fatalf("literal whitespace anchor: %v", err)
	}
	if got := rec.batchRequests[0][0].InsertText.Location.Index; got != 1 {
		t.Fatalf("literal whitespace insert index = %d, want 1", got)
	}
}

func TestDocsAtAnchorPreservesHTMLEntities(t *testing.T) {
	t.Parallel()

	rec := &docsAtAnchorRecorder{}
	svc := setupDocsAtAnchorTestService(t, docsFindRangeDoc(
		docsFindRangeParagraph(1, "literal &amp;\n"),
	), rec)

	ctx := withDocsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	if err := runKong(t, &DocsDeleteCmd{}, []string{"doc1", "--at", "&amp;"}, ctx, &RootFlags{Account: "a@b.com"}); err != nil {
		t.Fatalf("entity literal anchor: %v", err)
	}
	if got := rec.batchRequests[0][0].DeleteContentRange.Range; got.StartIndex != 9 || got.EndIndex != 14 {
		t.Fatalf("entity delete range = %#v, want 9:14", got)
	}
}

func TestDocsAtAnchorRejectsSkippedInlineObjectSpan(t *testing.T) {
	t.Parallel()

	rec := &docsAtAnchorRecorder{}
	svc := setupDocsAtAnchorTestService(t, &docs.Document{
		DocumentId: "doc1",
		Body: &docs.Body{
			Content: []*docs.StructuralElement{{
				StartIndex: 1,
				EndIndex:   5,
				Paragraph: &docs.Paragraph{Elements: []*docs.ParagraphElement{
					{StartIndex: 1, EndIndex: 2, TextRun: &docs.TextRun{Content: "a"}},
					{StartIndex: 2, EndIndex: 3, InlineObjectElement: &docs.InlineObjectElement{InlineObjectId: "img1"}},
					{StartIndex: 3, EndIndex: 5, TextRun: &docs.TextRun{Content: "b\n"}},
				}},
			}},
		},
	}, rec)

	ctx := withDocsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	err := runKong(t, &DocsDeleteCmd{}, []string{"doc1", "--at", "ab"}, ctx, &RootFlags{Account: "a@b.com"})
	if err == nil || ExitCode(err) != emptyResultsExitCode {
		t.Fatalf("skipped object span error = %v, exit=%d, want empty results", err, ExitCode(err))
	}
	if len(rec.batchRequests) != 0 {
		t.Fatalf("skipped object span mutated: %#v", rec.batchRequests)
	}
}

func TestDocsAtAnchorRejectsPageBreakInTable(t *testing.T) {
	t.Parallel()

	rec := &docsAtAnchorRecorder{}
	svc := setupDocsAtAnchorTestService(t, &docs.Document{
		DocumentId: "doc1",
		Body: &docs.Body{Content: []*docs.StructuralElement{{
			StartIndex: 1,
			EndIndex:   20,
			Table: &docs.Table{TableRows: []*docs.TableRow{{
				TableCells: []*docs.TableCell{{
					Content: []*docs.StructuralElement{
						docsFindRangeParagraph(5, "table anchor\n"),
					},
				}},
			}}},
		}}},
	}, rec)

	ctx := withDocsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	err := runKong(t, &DocsInsertPageBreakCmd{}, []string{"doc1", "--at", "table anchor"}, ctx, &RootFlags{Account: "a@b.com"})
	if err == nil || ExitCode(err) != 2 || !strings.Contains(err.Error(), "inside a table") {
		t.Fatalf("table page-break error = %v, exit=%d", err, ExitCode(err))
	}
	if len(rec.batchRequests) != 0 {
		t.Fatalf("table page-break mutated: %#v", rec.batchRequests)
	}
}

func TestDocsDeleteAtAnchorDryRunIncludesSelectors(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	ctx := newCmdRuntimeJSONOutputContext(t, &output, io.Discard)
	err := runKong(t, &DocsDeleteCmd{}, []string{"doc1", "--at", "target", "--occurrence", "2", "--match-case"}, ctx, &RootFlags{Account: "a@b.com", DryRun: true})
	if err == nil || ExitCode(err) != 0 {
		t.Fatalf("dry-run error = %v, exit=%d, want exit 0", err, ExitCode(err))
	}

	var got struct {
		Request map[string]any `json:"request"`
	}
	if err := json.Unmarshal(output.Bytes(), &got); err != nil {
		t.Fatalf("dry-run json: %v\nout=%q", err, output.String())
	}
	if got.Request["at"] != "target" {
		t.Fatalf("dry-run at = %v, want target", got.Request["at"])
	}
	if got.Request["occurrence"] != float64(2) {
		t.Fatalf("dry-run occurrence = %v, want 2", got.Request["occurrence"])
	}
	if got.Request["matchCase"] != true {
		t.Fatalf("dry-run matchCase = %v, want true", got.Request["matchCase"])
	}
}

func TestDocsAtAnchorAmbiguousAndNoMatchDoNotMutate(t *testing.T) {
	t.Parallel()

	rec := &docsAtAnchorRecorder{}
	svc := setupDocsAtAnchorTestService(t, docsFindRangeDoc(
		docsFindRangeParagraph(1, "target and target\n"),
	), rec)

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withDocsTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	err := runKong(t, &DocsInsertCmd{}, []string{"doc1", "X", "--at", "target"}, ctx, flags)
	if err == nil || ExitCode(err) != 2 || !strings.Contains(err.Error(), "ambiguous --at") || !strings.Contains(err.Error(), "1..2") {
		t.Fatalf("ambiguous error = %v, exit=%d", err, ExitCode(err))
	}
	if len(rec.batchRequests) != 0 {
		t.Fatalf("ambiguous anchor mutated: %#v", rec.batchRequests)
	}

	err = runKong(t, &DocsInsertPageBreakCmd{}, []string{"doc1", "--at", "missing"}, ctx, flags)
	if err == nil || ExitCode(err) != emptyResultsExitCode || !strings.Contains(err.Error(), "anchor not found") {
		t.Fatalf("missing error = %v, exit=%d", err, ExitCode(err))
	}
	if len(rec.batchRequests) != 0 {
		t.Fatalf("missing anchor mutated: %#v", rec.batchRequests)
	}
}

func assertDocsAtAnchorWriteControl(t *testing.T, rec *docsAtAnchorRecorder, batch int, want string) {
	t.Helper()
	if batch >= len(rec.batchBodies) {
		t.Fatalf("batch %d missing; have %d", batch, len(rec.batchBodies))
	}
	wc := rec.batchBodies[batch].WriteControl
	if wc == nil || wc.RequiredRevisionId != want {
		t.Fatalf("batch %d write control = %#v, want required revision %q", batch, wc, want)
	}
}

func TestDocsAtAnchorValidation(t *testing.T) {
	t.Parallel()

	flags := &RootFlags{Account: "a@b.com", DryRun: true}
	ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)
	cases := []struct {
		name string
		cmd  any
		args []string
		want string
	}{
		{
			name: "insert index",
			cmd:  &DocsInsertCmd{},
			args: []string{"doc1", "X", "--at", "target", "--index", "1"},
			want: "mutually exclusive",
		},
		{
			name: "delete partial numeric",
			cmd:  &DocsDeleteCmd{},
			args: []string{"doc1", "--start", "1"},
			want: "provide --at or both --start and --end",
		},
		{
			name: "delete at with numeric",
			cmd:  &DocsDeleteCmd{},
			args: []string{"doc1", "--at", "target", "--start", "1", "--end", "2"},
			want: "--at cannot be combined",
		},
		{
			name: "update index",
			cmd:  &DocsUpdateCmd{},
			args: []string{"doc1", "--text", "Y", "--at", "target", "--index", "1"},
			want: "--at cannot be combined",
		},
		{
			name: "person at end",
			cmd:  &DocsInsertPersonCmd{},
			args: []string{"doc1", "--email", "bot@example.com", "--at", "target", "--at-end"},
			want: "--at cannot be combined",
		},
		{
			name: "page break at end",
			cmd:  &DocsInsertPageBreakCmd{},
			args: []string{"doc1", "--at", "target", "--at-end"},
			want: "--at cannot be combined",
		},
		{
			name: "occurrence without at",
			cmd:  &DocsInsertCmd{},
			args: []string{"doc1", "X", "--occurrence", "1"},
			want: "--occurrence requires --at",
		},
		{
			name: "insert empty at",
			cmd:  &DocsInsertCmd{},
			args: []string{"doc1", "X", "--at", ""},
			want: "empty --at",
		},
		{
			name: "update empty at",
			cmd:  &DocsUpdateCmd{},
			args: []string{"doc1", "--text", "Y", "--at", ""},
			want: "empty --at",
		},
		{
			name: "delete empty at",
			cmd:  &DocsDeleteCmd{},
			args: []string{"doc1", "--at", ""},
			want: "empty --at",
		},
		{
			name: "person empty at",
			cmd:  &DocsInsertPersonCmd{},
			args: []string{"doc1", "--email", "bot@example.com", "--at", ""},
			want: "empty --at",
		},
		{
			name: "page break empty at",
			cmd:  &DocsInsertPageBreakCmd{},
			args: []string{"doc1", "--at", ""},
			want: "empty --at",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			err := runKong(t, tc.cmd, tc.args, ctx, flags)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}
