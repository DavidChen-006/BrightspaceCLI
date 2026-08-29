package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/api/slides/v1"
)

func updateNotesPresResponse() map[string]any {
	return map[string]any{
		"presentationId": "pres1",
		"slides": []any{
			map[string]any{
				"objectId": "slide_1",
				"slideProperties": map[string]any{
					"notesPage": map[string]any{
						"notesProperties": map[string]any{
							"speakerNotesObjectId": "notes_body_1",
						},
						"pageElements": []any{
							map[string]any{
								"objectId": "notes_body_1",
								"shape": map[string]any{
									"placeholder": map[string]any{"type": "BODY"},
									"text": map[string]any{
										"textElements": []any{
											map[string]any{
												"textRun": map[string]any{
													"content": "Existing notes",
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	}
}

func updateNotesEmptyPresResponse() map[string]any {
	resp := updateNotesPresResponse()
	notesShape := resp["slides"].([]any)[0].(map[string]any)["slideProperties"].(map[string]any)["notesPage"].(map[string]any)["pageElements"].([]any)[0].(map[string]any)["shape"].(map[string]any)
	delete(notesShape, "text")
	return resp
}

func ptrString(v string) *string { return &v }

func newSlidesUpdateNotesTestService(
	t *testing.T,
	presentation map[string]any,
	capturedRequests *[]*slides.Request,
	insertedText *string,
) *slides.Service {
	t.Helper()

	svc, closeServer := newGoogleTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, ":batchUpdate") && r.Method == http.MethodPost:
			var req slides.BatchUpdatePresentationRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
				if capturedRequests != nil {
					*capturedRequests = req.Requests
				}
				if insertedText != nil {
					for _, request := range req.Requests {
						if request.InsertText != nil {
							*insertedText = request.InsertText.Text
						}
					}
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"presentationId": "pres1",
				"replies":        []any{},
			})
		case strings.Contains(r.URL.Path, "/presentations/pres1") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(presentation)
		default:
			http.NotFound(w, r)
		}
	}), slides.NewService)
	t.Cleanup(closeServer)
	return svc
}

func TestSlidesUpdateNotes(t *testing.T) {
	var capturedRequests []*slides.Request
	svc := newSlidesUpdateNotesTestService(t, updateNotesPresResponse(), &capturedRequests, nil)
	flags := &RootFlags{Account: "a@b.com"}
	var out bytes.Buffer
	ctx := withSlidesTestService(newCmdRuntimeOutputContext(t, &out, io.Discard), svc)

	cmd := &SlidesUpdateNotesCmd{
		PresentationID: "pres1",
		SlideID:        "slide_1",
		Notes:          ptrString("Updated notes content"),
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if !strings.Contains(out.String(), "Updated notes on slide slide_1") {
		t.Errorf("expected confirmation message, got: %q", out.String())
	}

	// Verify batch contained DeleteText + InsertText
	if len(capturedRequests) != 2 {
		t.Fatalf("expected 2 requests in batch, got %d", len(capturedRequests))
	}
	if capturedRequests[0].DeleteText == nil {
		t.Error("expected first request to be DeleteText")
	}
	if capturedRequests[1].InsertText == nil {
		t.Error("expected second request to be InsertText")
	} else if capturedRequests[1].InsertText.Text != "Updated notes content" {
		t.Errorf("expected inserted text to be 'Updated notes content', got %q", capturedRequests[1].InsertText.Text)
	}
}

func TestSlidesUpdateNotes_JSON(t *testing.T) {
	svc := newSlidesUpdateNotesTestService(t, updateNotesPresResponse(), nil, nil)
	flags := &RootFlags{Account: "a@b.com"}
	var out bytes.Buffer
	ctx := withSlidesTestService(newCmdRuntimeJSONOutputContext(t, &out, io.Discard), svc)
	cmd := &SlidesUpdateNotesCmd{
		PresentationID: "pres1",
		SlideID:        "slide_1",
		Notes:          ptrString("Updated notes content"),
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var got struct {
		PresentationID string `json:"presentationId"`
		SlideObjectID  string `json:"slideObjectId"`
		NotesLength    int    `json:"notesLength"`
		Requests       int    `json:"requests"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("JSON parse: %v\noutput: %q", err, out.String())
	}
	if got.PresentationID != "pres1" || got.SlideObjectID != "slide_1" || got.NotesLength == 0 || got.Requests != 2 {
		t.Fatalf("unexpected JSON output: %#v", got)
	}
}

func TestSlidesUpdateNotes_EmptySpeakerNotesInsertsOnly(t *testing.T) {
	var capturedRequests []*slides.Request
	svc := newSlidesUpdateNotesTestService(t, updateNotesEmptyPresResponse(), &capturedRequests, nil)
	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSlidesTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	cmd := &SlidesUpdateNotesCmd{
		PresentationID: "pres1",
		SlideID:        "slide_1",
		Notes:          ptrString("New notes"),
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if len(capturedRequests) != 1 {
		t.Fatalf("expected 1 request for empty notes, got %d", len(capturedRequests))
	}
	if capturedRequests[0].InsertText == nil {
		t.Fatalf("expected InsertText only, got %+v", capturedRequests[0])
	}
	if capturedRequests[0].InsertText.Text != "New notes" {
		t.Fatalf("inserted text = %q", capturedRequests[0].InsertText.Text)
	}
}

func TestSlidesUpdateNotes_NotesFile(t *testing.T) {
	var insertedText string
	svc := newSlidesUpdateNotesTestService(t, updateNotesPresResponse(), nil, &insertedText)

	notesPath := filepath.Join(t.TempDir(), "notes.md")
	notesContent := "# Updated Notes\n\nFrom a file.\n"
	if err := os.WriteFile(notesPath, []byte(notesContent), 0o644); err != nil {
		t.Fatalf("write notes: %v", err)
	}

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSlidesTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)
	cmd := &SlidesUpdateNotesCmd{
		PresentationID: "pres1",
		SlideID:        "slide_1",
		NotesFile:      notesPath,
		Notes:          ptrString("this should be ignored"),
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if insertedText != notesContent {
		t.Errorf("expected notes from file, got: %q", insertedText)
	}
}

func TestSlidesUpdateNotes_SlideNotFound(t *testing.T) {
	svc := newSlidesUpdateNotesTestService(t, updateNotesPresResponse(), nil, nil)
	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSlidesTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	cmd := &SlidesUpdateNotesCmd{
		PresentationID: "pres1",
		SlideID:        "nonexistent",
		Notes:          ptrString("some notes"),
	}
	err := cmd.Run(ctx, flags)
	if err == nil || !strings.Contains(err.Error(), `slide "nonexistent" not found`) {
		t.Fatalf("expected slide-not-found error, got: %v", err)
	}
}

func TestSlidesUpdateNotes_EmptyNotes(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSlidesTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*slides.Service, error) {
			t.Fatal("slides service should not be created")
			return nil, context.Canceled
		},
	)

	cmd := &SlidesUpdateNotesCmd{
		PresentationID: "pres1",
		SlideID:        "slide_1",
	}
	err := cmd.Run(ctx, flags)
	if err == nil || !strings.Contains(err.Error(), "provide --notes or --notes-file") {
		t.Fatalf("expected empty notes error, got: %v", err)
	}
}

func TestSlidesUpdateNotes_ClearWithEmptyNotesFlag(t *testing.T) {
	var capturedRequests []*slides.Request
	svc := newSlidesUpdateNotesTestService(t, updateNotesPresResponse(), &capturedRequests, nil)
	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSlidesTestService(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), svc)

	cmd := &SlidesUpdateNotesCmd{
		PresentationID: "pres1",
		SlideID:        "slide_1",
		Notes:          ptrString(""),
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if len(capturedRequests) != 1 {
		t.Fatalf("expected 1 request in batch for clear, got %d", len(capturedRequests))
	}
	if capturedRequests[0].DeleteText == nil {
		t.Fatal("expected DeleteText request when clearing notes")
	}
}
