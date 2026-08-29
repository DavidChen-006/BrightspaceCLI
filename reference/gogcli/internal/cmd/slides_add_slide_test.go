package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
	"google.golang.org/api/slides/v1"
)

// slidesPresGetResponse returns a minimal presentation JSON with one existing slide.
// If includeNotes is true, the second slide (matching slideID) includes notes page details.
func slidesPresGetResponse(slideID string, includeNotes bool) map[string]any {
	existingSlide := map[string]any{
		"objectId": "existing_slide_1",
		"slideProperties": map[string]any{
			"notesPage": map[string]any{},
		},
	}

	resp := map[string]any{
		"presentationId": "pres1",
		"pageSize": map[string]any{
			"width":  map[string]any{"magnitude": 9144000, "unit": "EMU"},
			"height": map[string]any{"magnitude": 5143500, "unit": "EMU"},
		},
		"slides": []any{existingSlide},
	}

	if includeNotes && slideID != "" {
		newSlide := map[string]any{
			"objectId": slideID,
			"slideProperties": map[string]any{
				"notesPage": map[string]any{
					"notesProperties": map[string]any{
						"speakerNotesObjectId": "notes_body_1",
					},
					"pageElements": []any{
						map[string]any{
							"objectId": "notes_body_1",
							"shape": map[string]any{
								"placeholder": map[string]any{
									"type": "BODY",
								},
							},
						},
					},
				},
			},
		}
		s := resp["slides"].([]any)
		resp["slides"] = append(s, newSlide)
	}

	return resp
}

func newTestImage(t *testing.T, name string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	// Write a minimal 1x1 PNG (valid header is not required for the mock)
	if err := os.WriteFile(path, []byte("fake-image-data"), 0o644); err != nil {
		t.Fatalf("write test image: %v", err)
	}
	return path
}

func TestSlidesAddSlide_NoNotes(t *testing.T) {
	var batchUpdateCount int

	slidesSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.HasSuffix(r.URL.Path, ":batchUpdate") && r.Method == http.MethodPost:
			batchUpdateCount++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"presentationId": "pres1",
				"replies":        []any{map[string]any{}, map[string]any{}},
			})
		case strings.Contains(r.URL.Path, "/presentations/pres1") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(slidesPresGetResponse("", false))
		default:
			http.NotFound(w, r)
		}
	}))
	defer slidesSrv.Close()

	var deleteCalled bool
	driveSvc := newSlidesImageDriveTestService(t, "img_123", &deleteCalled)

	slidesSvc, err := slides.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(slidesSrv.Client()),
		option.WithEndpoint(slidesSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("slides.NewService: %v", err)
	}

	imgPath := newTestImage(t, "test.png")
	flags := &RootFlags{Account: "a@b.com"}

	var stdout, stderr bytes.Buffer
	ctx := withSlidesAndDriveTestServices(newCmdRuntimeOutputContext(t, &stdout, &stderr), slidesSvc, driveSvc)
	cmd := &SlidesAddSlideCmd{
		PresentationID: "pres1",
		Image:          imgPath,
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if !strings.Contains(stdout.String(), "slide\t2") {
		t.Errorf("expected slide number 2, got: %q", stdout.String())
	}
	if !strings.Contains(stdout.String(), "link\thttps://docs.google.com/presentation/d/pres1/edit") {
		t.Errorf("expected presentation link, got: %q", stdout.String())
	}
	if batchUpdateCount != 1 {
		t.Errorf("expected 1 batchUpdate (no notes), got %d", batchUpdateCount)
	}
	if !deleteCalled {
		t.Errorf("expected Drive file cleanup delete")
	}
}

func TestSlidesAddSlide_WithNotes(t *testing.T) {
	var batchUpdateCount int
	var lastSlideID string

	slidesSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.HasSuffix(r.URL.Path, ":batchUpdate") && r.Method == http.MethodPost:
			batchUpdateCount++
			// On the first batchUpdate, capture the slideID from the request
			if batchUpdateCount == 1 {
				var req slides.BatchUpdatePresentationRequest
				if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
					for _, rr := range req.Requests {
						if rr.CreateSlide != nil {
							lastSlideID = rr.CreateSlide.ObjectId
						}
					}
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"presentationId": "pres1",
				"replies":        []any{},
			})
		case strings.Contains(r.URL.Path, "/presentations/pres1") && r.Method == http.MethodGet:
			// After the first batchUpdate, return the notes page with the new slide
			resp := slidesPresGetResponse(lastSlideID, lastSlideID != "")
			_ = json.NewEncoder(w).Encode(resp)
		default:
			http.NotFound(w, r)
		}
	}))
	defer slidesSrv.Close()

	driveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.Contains(r.URL.Path, "/upload/") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "img_456",
				"webContentLink": "https://drive.google.com/uc?id=img_456",
			})
		case strings.Contains(r.URL.Path, "/files/img_456/permissions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "perm1"})
		case strings.Contains(r.URL.Path, "/files/img_456") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer driveSrv.Close()

	slidesSvc, err := slides.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(slidesSrv.Client()),
		option.WithEndpoint(slidesSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("slides.NewService: %v", err)
	}

	driveSvc, err := drive.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(driveSrv.Client()),
		option.WithEndpoint(driveSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("drive.NewService: %v", err)
	}

	imgPath := newTestImage(t, "slide.jpg")
	flags := &RootFlags{Account: "a@b.com"}

	var stdout, stderr bytes.Buffer
	ctx := withSlidesAndDriveTestServices(newCmdRuntimeOutputContext(t, &stdout, &stderr), slidesSvc, driveSvc)
	cmd := &SlidesAddSlideCmd{
		PresentationID: "pres1",
		Image:          imgPath,
		Notes:          "Hello speaker notes",
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if !strings.Contains(stdout.String(), "slide\t2") {
		t.Errorf("expected slide number 2, got: %q", stdout.String())
	}
	// With notes: 1 for create slide+image, 1 for insert text
	if batchUpdateCount != 2 {
		t.Errorf("expected 2 batchUpdates (with notes), got %d", batchUpdateCount)
	}
}

func TestSlidesAddSlide_RetriesImageFetchAndUsesDownloadURL(t *testing.T) {
	origRetryDelays := docsImageInsertRetryDelays
	t.Cleanup(func() {
		docsImageInsertRetryDelays = origRetryDelays
	})
	docsImageInsertRetryDelays = []time.Duration{0}

	var batchUpdateCount int
	var createImageURL string

	slidesSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.HasSuffix(r.URL.Path, ":batchUpdate") && r.Method == http.MethodPost:
			batchUpdateCount++
			var req slides.BatchUpdatePresentationRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
				for _, rr := range req.Requests {
					if rr.CreateImage != nil {
						createImageURL = rr.CreateImage.Url
					}
				}
			}
			if batchUpdateCount == 1 {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"code":    http.StatusBadRequest,
						"message": "Invalid requests[1].createImage: There was a problem retrieving the image.",
					},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"presentationId": "pres1",
				"replies":        []any{},
			})
		case strings.Contains(r.URL.Path, "/presentations/pres1") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(slidesPresGetResponse("", false))
		default:
			http.NotFound(w, r)
		}
	}))
	defer slidesSrv.Close()

	driveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.Contains(r.URL.Path, "/upload/") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "img_retry"})
		case strings.Contains(r.URL.Path, "/files/img_retry/permissions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "perm1"})
		case strings.Contains(r.URL.Path, "/files/img_retry") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer driveSrv.Close()

	slidesSvc, err := slides.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(slidesSrv.Client()),
		option.WithEndpoint(slidesSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("slides.NewService: %v", err)
	}

	driveSvc, err := drive.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(driveSrv.Client()),
		option.WithEndpoint(driveSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("drive.NewService: %v", err)
	}
	ctx := withSlidesAndDriveTestServices(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), slidesSvc, driveSvc)

	cmd := &SlidesAddSlideCmd{
		PresentationID: "pres1",
		Image:          newTestImage(t, "test.png"),
	}
	if err := cmd.Run(ctx, &RootFlags{Account: "a@b.com"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if batchUpdateCount != 2 {
		t.Fatalf("expected retry after image retrieval failure, got %d batchUpdates", batchUpdateCount)
	}
	if createImageURL != driveImageDownloadURL("img_retry") {
		t.Fatalf("CreateImage URL = %q, want %q", createImageURL, driveImageDownloadURL("img_retry"))
	}
}

func TestSlidesAddSlide_NotesFile(t *testing.T) {
	var insertedText string
	var lastSlideID string
	var batchCount int

	slidesSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.HasSuffix(r.URL.Path, ":batchUpdate") && r.Method == http.MethodPost:
			batchCount++
			var req slides.BatchUpdatePresentationRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
				for _, rr := range req.Requests {
					if rr.CreateSlide != nil {
						lastSlideID = rr.CreateSlide.ObjectId
					}
					if rr.InsertText != nil {
						insertedText = rr.InsertText.Text
					}
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"presentationId": "pres1",
				"replies":        []any{},
			})
		case strings.Contains(r.URL.Path, "/presentations/pres1") && r.Method == http.MethodGet:
			resp := slidesPresGetResponse(lastSlideID, lastSlideID != "")
			_ = json.NewEncoder(w).Encode(resp)
		default:
			http.NotFound(w, r)
		}
	}))
	defer slidesSrv.Close()

	driveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.Contains(r.URL.Path, "/upload/") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "img_789",
				"webContentLink": "https://drive.google.com/uc?id=img_789",
			})
		case strings.Contains(r.URL.Path, "/files/img_789/permissions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "perm1"})
		case strings.Contains(r.URL.Path, "/files/img_789") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer driveSrv.Close()

	slidesSvc, err := slides.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(slidesSrv.Client()),
		option.WithEndpoint(slidesSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("slides.NewService: %v", err)
	}

	driveSvc, err := drive.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(driveSrv.Client()),
		option.WithEndpoint(driveSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("drive.NewService: %v", err)
	}

	imgPath := newTestImage(t, "slide.png")

	// Write a notes file
	notesPath := filepath.Join(t.TempDir(), "notes.md")
	notesContent := "# Slide Notes\n\nMultiline markdown notes.\n"
	if err := os.WriteFile(notesPath, []byte(notesContent), 0o644); err != nil {
		t.Fatalf("write notes: %v", err)
	}

	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSlidesAndDriveTestServices(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), slidesSvc, driveSvc)
	cmd := &SlidesAddSlideCmd{
		PresentationID: "pres1",
		Image:          imgPath,
		NotesFile:      notesPath,
		Notes:          "this should be ignored",
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// --notes-file takes precedence over --notes
	if insertedText != notesContent {
		t.Errorf("expected notes from file, got: %q", insertedText)
	}
}

func TestSlidesAddSlide_JSON(t *testing.T) {
	slidesSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.HasSuffix(r.URL.Path, ":batchUpdate") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"presentationId": "pres1",
				"replies":        []any{},
			})
		case strings.Contains(r.URL.Path, "/presentations/pres1") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(slidesPresGetResponse("", false))
		default:
			http.NotFound(w, r)
		}
	}))
	defer slidesSrv.Close()

	driveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.Contains(r.URL.Path, "/upload/") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "img_json",
				"webContentLink": "https://drive.google.com/uc?id=img_json",
			})
		case strings.Contains(r.URL.Path, "/files/img_json/permissions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "perm1"})
		case strings.Contains(r.URL.Path, "/files/img_json") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer driveSrv.Close()

	slidesSvc, err := slides.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(slidesSrv.Client()),
		option.WithEndpoint(slidesSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("slides.NewService: %v", err)
	}

	driveSvc, err := drive.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(driveSrv.Client()),
		option.WithEndpoint(driveSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("drive.NewService: %v", err)
	}

	imgPath := newTestImage(t, "test.gif")
	flags := &RootFlags{Account: "a@b.com"}

	var stdout, stderr bytes.Buffer
	ctx := withSlidesAndDriveTestServices(newCmdRuntimeJSONOutputContext(t, &stdout, &stderr), slidesSvc, driveSvc)
	cmd := &SlidesAddSlideCmd{
		PresentationID: "pres1",
		Image:          imgPath,
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("JSON parse: %v\noutput: %q", err, stdout.String())
	}
	if result["slideNumber"] != float64(2) {
		t.Errorf("expected slideNumber=2, got %v", result["slideNumber"])
	}
	if result["presentationId"] != "pres1" {
		t.Errorf("expected presentationId=pres1, got %v", result["presentationId"])
	}
	if result["link"] != "https://docs.google.com/presentation/d/pres1/edit" {
		t.Errorf("unexpected link: %v", result["link"])
	}
}

func TestSlidesAddSlide_Before(t *testing.T) {
	var capturedCreateSlide *slides.CreateSlideRequest

	// Presentation has 3 slides; we insert before the second one (index 1).
	presResp := map[string]any{
		"presentationId": "pres1",
		"pageSize": map[string]any{
			"width":  map[string]any{"magnitude": 9144000, "unit": "EMU"},
			"height": map[string]any{"magnitude": 5143500, "unit": "EMU"},
		},
		"slides": []any{
			map[string]any{"objectId": "slide_a", "slideProperties": map[string]any{}},
			map[string]any{"objectId": "slide_b", "slideProperties": map[string]any{}},
			map[string]any{"objectId": "slide_c", "slideProperties": map[string]any{}},
		},
	}

	slidesSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.HasSuffix(r.URL.Path, ":batchUpdate") && r.Method == http.MethodPost:
			var req slides.BatchUpdatePresentationRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
				for _, rr := range req.Requests {
					if rr.CreateSlide != nil {
						capturedCreateSlide = rr.CreateSlide
					}
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"presentationId": "pres1",
				"replies":        []any{},
			})
		case strings.Contains(r.URL.Path, "/presentations/pres1") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(presResp)
		default:
			http.NotFound(w, r)
		}
	}))
	defer slidesSrv.Close()

	driveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.Contains(r.URL.Path, "/upload/") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "img_before",
				"webContentLink": "https://drive.google.com/uc?id=img_before",
			})
		case strings.Contains(r.URL.Path, "/files/img_before/permissions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "perm1"})
		case strings.Contains(r.URL.Path, "/files/img_before") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer driveSrv.Close()

	slidesSvc, err := slides.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(slidesSrv.Client()),
		option.WithEndpoint(slidesSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("slides.NewService: %v", err)
	}

	driveSvc, err := drive.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(driveSrv.Client()),
		option.WithEndpoint(driveSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("drive.NewService: %v", err)
	}

	imgPath := newTestImage(t, "test.png")
	flags := &RootFlags{Account: "a@b.com"}

	var stdout, stderr bytes.Buffer
	ctx := withSlidesAndDriveTestServices(newCmdRuntimeOutputContext(t, &stdout, &stderr), slidesSvc, driveSvc)
	cmd := &SlidesAddSlideCmd{
		PresentationID: "pres1",
		Image:          imgPath,
		Before:         "slide_b",
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if capturedCreateSlide == nil {
		t.Fatal("expected CreateSlide request to be captured")
	}
	if capturedCreateSlide.InsertionIndex != 1 {
		t.Errorf("expected InsertionIndex=1, got %d", capturedCreateSlide.InsertionIndex)
	}
	// Slide inserted before index 1 → new slide is slide number 2
	if !strings.Contains(stdout.String(), "slide\t2") {
		t.Errorf("expected slide number 2, got: %q", stdout.String())
	}
}

func TestSlidesAddSlide_BeforeNotFound(t *testing.T) {
	slidesSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.Contains(r.URL.Path, "/presentations/pres1") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(slidesPresGetResponse("", false))
		default:
			http.NotFound(w, r)
		}
	}))
	defer slidesSrv.Close()

	driveSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.Contains(r.URL.Path, "/upload/") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "img_nf",
				"webContentLink": "https://drive.google.com/uc?id=img_nf",
			})
		case strings.Contains(r.URL.Path, "/files/img_nf/permissions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "perm1"})
		case strings.Contains(r.URL.Path, "/files/img_nf") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer driveSrv.Close()

	slidesSvc, err := slides.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(slidesSrv.Client()),
		option.WithEndpoint(slidesSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("slides.NewService: %v", err)
	}

	driveSvc, err := drive.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(driveSrv.Client()),
		option.WithEndpoint(driveSrv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("drive.NewService: %v", err)
	}

	imgPath := newTestImage(t, "test.png")
	flags := &RootFlags{Account: "a@b.com"}

	ctx := withSlidesAndDriveTestServices(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), slidesSvc, driveSvc)

	cmd := &SlidesAddSlideCmd{
		PresentationID: "pres1",
		Image:          imgPath,
		Before:         "nonexistent_slide",
	}
	err = cmd.Run(ctx, flags)
	if err == nil || !strings.Contains(err.Error(), `slide "nonexistent_slide" not found`) {
		t.Fatalf("expected slide-not-found error, got: %v", err)
	}
}

func TestSlidesAddSlide_UnsupportedFormat(t *testing.T) {
	// Services should not be called for a format error
	slidesFactory := func(context.Context, string) (*slides.Service, error) {
		t.Fatal("slides service should not be created")
		return nil, context.Canceled
	}
	driveFactory := func(context.Context, string) (*drive.Service, error) {
		t.Fatal("drive service should not be created")
		return nil, context.Canceled
	}

	imgPath := newTestImage(t, "test.bmp")
	flags := &RootFlags{Account: "a@b.com"}

	ctx := withSlidesTestServiceFactory(
		withDriveTestServiceFactory(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), driveFactory),
		slidesFactory,
	)

	cmd := &SlidesAddSlideCmd{
		PresentationID: "pres1",
		Image:          imgPath,
	}
	err := cmd.Run(ctx, flags)
	if err == nil || !strings.Contains(err.Error(), "unsupported image format") {
		t.Fatalf("expected unsupported format error, got: %v", err)
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("expected usage exit code 2, got %d (err=%v)", got, err)
	}
}
