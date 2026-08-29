package cmd

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/slides/v1"
)

type slidesTemplateTestFixture struct {
	driveRequest   *http.Request
	slidesRequests []*slides.Request
	driveService   *drive.Service
	slidesService  *slides.Service
}

func newSlidesTemplateTestFixture(
	t *testing.T,
	templateID string,
	copiedID string,
	title string,
	occurrences int64,
) *slidesTemplateTestFixture {
	t.Helper()
	fixture := &slidesTemplateTestFixture{}
	driveHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.driveRequest = r
		if r.Method != http.MethodPost || !strings.Contains(r.URL.Path, "/files/"+templateID+"/copy") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(&drive.File{
			Id: copiedID, Name: title, MimeType: "application/vnd.google-apps.presentation",
			WebViewLink: "https://docs.google.com/presentation/d/" + copiedID + "/edit",
		})
	})
	slidesHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/presentations/"+copiedID+":batchUpdate" {
			http.NotFound(w, r)
			return
		}
		var request slides.BatchUpdatePresentationRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		fixture.slidesRequests = request.Requests
		replies := make([]*slides.Response, len(request.Requests))
		for i := range request.Requests {
			replies[i] = &slides.Response{ReplaceAllText: &slides.ReplaceAllTextResponse{OccurrencesChanged: occurrences}}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(&slides.BatchUpdatePresentationResponse{PresentationId: copiedID, Replies: replies})
	})
	var closeDrive, closeSlides func()
	fixture.driveService, closeDrive = newGoogleTestService(t, driveHandler, drive.NewService)
	fixture.slidesService, closeSlides = newGoogleTestService(t, slidesHandler, slides.NewService)
	t.Cleanup(closeDrive)
	t.Cleanup(closeSlides)
	return fixture
}

func TestSlidesCreateFromTemplate_Basic(t *testing.T) {
	fixture := newSlidesTemplateTestFixture(t, "template123", "copied123", "New Presentation", 2)

	cmd := &SlidesCreateFromTemplateCmd{
		TemplateID: "template123",
		Title:      "New Presentation",
		Replace:    []string{"name=John Doe", "company=ACME Corp"},
	}

	ctx := withSlidesAndDriveTestServices(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), fixture.slidesService, fixture.driveService)

	err := cmd.Run(ctx, &RootFlags{Account: "test@example.com"})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}

	// Verify Drive API call
	if fixture.driveRequest == nil {
		t.Fatal("Drive API was not called")
	}

	// Verify Slides API calls
	if len(fixture.slidesRequests) != 2 {
		t.Fatalf("Expected 2 replacement requests, got %d", len(fixture.slidesRequests))
	}

	got := make(map[string]string, len(fixture.slidesRequests))
	for _, req := range fixture.slidesRequests {
		if req.ReplaceAllText == nil {
			t.Fatal("request is not ReplaceAllText")
		}
		got[req.ReplaceAllText.ContainsText.Text] = req.ReplaceAllText.ReplaceText
	}
	if got["{{name}}"] != "John Doe" {
		t.Errorf("expected {{name}} => John Doe, got %q", got["{{name}}"])
	}
	if got["{{company}}"] != "ACME Corp" {
		t.Errorf("expected {{company}} => ACME Corp, got %q", got["{{company}}"])
	}
}

func TestSlidesCreateFromTemplate_JSONFile(t *testing.T) {
	tmpDir := t.TempDir()
	jsonFile := filepath.Join(tmpDir, "replacements.json")

	replacements := map[string]interface{}{
		"name":    "Jane Smith",
		"age":     30,
		"active":  true,
		"company": "TechCorp",
	}

	data, err := json.Marshal(replacements)
	if err != nil {
		t.Fatal(err)
	}

	if writeErr := os.WriteFile(jsonFile, data, 0o644); writeErr != nil {
		t.Fatal(writeErr)
	}

	fixture := newSlidesTemplateTestFixture(t, "template456", "copied456", "Test Presentation", 1)

	cmd := &SlidesCreateFromTemplateCmd{
		TemplateID:   "template456",
		Title:        "Test Presentation",
		Replacements: jsonFile,
	}

	ctx := withSlidesAndDriveTestServices(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), fixture.slidesService, fixture.driveService)

	err = cmd.Run(ctx, &RootFlags{Account: "test@example.com"})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}

	// Should have 4 replacements
	if len(fixture.slidesRequests) != 4 {
		t.Fatalf("Expected 4 replacement requests, got %d", len(fixture.slidesRequests))
	}

	// Verify type conversions
	foundAge := false
	foundActive := false
	for _, req := range fixture.slidesRequests {
		if req.ReplaceAllText != nil {
			text := req.ReplaceAllText.ContainsText.Text
			if text == "{{age}}" {
				foundAge = true
				if req.ReplaceAllText.ReplaceText != "30" {
					t.Errorf("Expected age '30', got %s", req.ReplaceAllText.ReplaceText)
				}
			}
			if text == "{{active}}" {
				foundActive = true
				if req.ReplaceAllText.ReplaceText != "true" {
					t.Errorf("Expected active 'true', got %s", req.ReplaceAllText.ReplaceText)
				}
			}
		}
	}

	if !foundAge {
		t.Error("Did not find age replacement")
	}
	if !foundActive {
		t.Error("Did not find active replacement")
	}
}

func TestSlidesCreateFromTemplate_ExactMode(t *testing.T) {
	fixture := newSlidesTemplateTestFixture(t, "template789", "copied789", "Exact Mode Test", 1)

	cmd := &SlidesCreateFromTemplateCmd{
		TemplateID: "template789",
		Title:      "Exact Mode Test",
		Replace:    []string{"OLD_TEXT=NEW_TEXT"},
		Exact:      true,
	}

	ctx := withSlidesAndDriveTestServices(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), fixture.slidesService, fixture.driveService)

	err := cmd.Run(ctx, &RootFlags{Account: "test@example.com"})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}

	if len(fixture.slidesRequests) != 1 {
		t.Fatalf("Expected 1 replacement request, got %d", len(fixture.slidesRequests))
	}

	// In exact mode, should search for "OLD_TEXT" not "{{OLD_TEXT}}"
	if fixture.slidesRequests[0].ReplaceAllText.ContainsText.Text != "OLD_TEXT" {
		t.Errorf("Expected 'OLD_TEXT', got %s", fixture.slidesRequests[0].ReplaceAllText.ContainsText.Text)
	}
}

func TestSlidesCreateFromTemplate_EmptyReplacements(t *testing.T) {
	cmd := &SlidesCreateFromTemplateCmd{
		TemplateID: "template123",
		Title:      "Test",
	}

	ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)

	err := cmd.Run(ctx, &RootFlags{Account: "test@example.com"})
	if err == nil {
		t.Fatal("Expected error for empty replacements, got nil")
	}
	if ExitCode(err) != 2 {
		t.Errorf("Expected usage error (exit code 2), got: %v", err)
	}
}

func TestSlidesCreateFromTemplate_InvalidReplaceFormat(t *testing.T) {
	cmd := &SlidesCreateFromTemplateCmd{
		TemplateID: "template123",
		Title:      "Test",
		Replace:    []string{"invalid_no_equals_sign"},
	}

	ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)

	err := cmd.Run(ctx, &RootFlags{Account: "test@example.com"})
	if err == nil {
		t.Fatal("Expected error for invalid replace format, got nil")
	}
	if ExitCode(err) != 2 {
		t.Errorf("Expected usage error (exit code 2), got: %v", err)
	}
}

func TestSlidesCreateFromTemplate_InvalidJSON(t *testing.T) {
	tmpDir := t.TempDir()
	jsonFile := filepath.Join(tmpDir, "invalid.json")

	if err := os.WriteFile(jsonFile, []byte("{invalid json}"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := &SlidesCreateFromTemplateCmd{
		TemplateID:   "template123",
		Title:        "Test",
		Replacements: jsonFile,
	}

	ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)

	err := cmd.Run(ctx, &RootFlags{Account: "test@example.com"})
	if err == nil {
		t.Fatal("Expected error for invalid JSON, got nil")
	}
	if ExitCode(err) != 2 {
		t.Errorf("Expected usage error (exit code 2), got: %v", err)
	}
}

func TestSlidesCreateFromTemplate_CombineFileAndFlags(t *testing.T) {
	tmpDir := t.TempDir()
	jsonFile := filepath.Join(tmpDir, "replacements.json")

	fileReplacements := map[string]string{
		"name":    "From File",
		"company": "File Corp",
	}

	data, err := json.Marshal(fileReplacements)
	if err != nil {
		t.Fatal(err)
	}

	if writeErr := os.WriteFile(jsonFile, data, 0o644); writeErr != nil {
		t.Fatal(writeErr)
	}

	fixture := newSlidesTemplateTestFixture(t, "template999", "copied999", "Combined Test", 1)

	// Flag overrides file
	cmd := &SlidesCreateFromTemplateCmd{
		TemplateID:   "template999",
		Title:        "Combined Test",
		Replacements: jsonFile,
		Replace:      []string{"name=From Flag"},
	}

	ctx := withSlidesAndDriveTestServices(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), fixture.slidesService, fixture.driveService)

	err = cmd.Run(ctx, &RootFlags{Account: "test@example.com"})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}

	// Should have 2 replacements (name and company)
	if len(fixture.slidesRequests) != 2 {
		t.Fatalf("Expected 2 replacement requests, got %d", len(fixture.slidesRequests))
	}

	// Verify that flag value overrides file value
	foundNameOverride := false
	for _, req := range fixture.slidesRequests {
		if req.ReplaceAllText != nil && req.ReplaceAllText.ContainsText.Text == "{{name}}" {
			foundNameOverride = true
			if req.ReplaceAllText.ReplaceText != "From Flag" {
				t.Errorf("Expected 'From Flag', got %s", req.ReplaceAllText.ReplaceText)
			}
		}
	}

	if !foundNameOverride {
		t.Error("Flag should override file value for 'name'")
	}
}

func TestSlidesCreateFromTemplate_DryRunSkipsAPICalls(t *testing.T) {
	driveCalls := 0
	slidesCalls := 0
	driveFactory := func(context.Context, string) (*drive.Service, error) {
		driveCalls++
		t.Fatal("drive service should not be created during dry-run")
		return &drive.Service{}, nil
	}
	slidesFactory := func(context.Context, string) (*slides.Service, error) {
		slidesCalls++
		t.Fatal("slides service should not be created during dry-run")
		return &slides.Service{}, nil
	}

	cmd := &SlidesCreateFromTemplateCmd{
		TemplateID: "template123",
		Title:      "Dry Run Deck",
		Replace:    []string{"name=John Doe"},
		Parent:     "https://drive.google.com/drive/folders/parent123",
	}

	ctx := withSlidesTestServiceFactory(
		withDriveTestServiceFactory(newCmdRuntimeOutputContext(t, io.Discard, io.Discard), driveFactory),
		slidesFactory,
	)

	err := cmd.Run(ctx, &RootFlags{Account: "test@example.com", DryRun: true, NoInput: true})
	if ExitCode(err) != 0 {
		t.Fatalf("expected dry-run exit 0, got %v", err)
	}
	if driveCalls != 0 || slidesCalls != 0 {
		t.Fatalf("expected no API calls, got drive=%d slides=%d", driveCalls, slidesCalls)
	}
}
