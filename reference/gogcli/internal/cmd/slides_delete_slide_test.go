package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/option"
	"google.golang.org/api/slides/v1"
)

func TestSlidesDeleteSlide(t *testing.T) {
	var deletedObjectID string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.HasSuffix(r.URL.Path, ":batchUpdate") && r.Method == http.MethodPost:
			var req slides.BatchUpdatePresentationRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
				for _, rr := range req.Requests {
					if rr.DeleteObject != nil {
						deletedObjectID = rr.DeleteObject.ObjectId
					}
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"presentationId": "pres1",
				"replies":        []any{},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	svc, err := slides.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("slides.NewService: %v", err)
	}

	flags := &RootFlags{Account: "a@b.com", Force: true}
	var out bytes.Buffer
	ctx := withSlidesTestService(newCmdRuntimeOutputContext(t, &out, io.Discard), svc)

	cmd := &SlidesDeleteSlideCmd{
		PresentationID: "pres1",
		SlideID:        "slide_abc",
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if deletedObjectID != "slide_abc" {
		t.Errorf("expected delete of slide_abc, got %q", deletedObjectID)
	}
}

func TestSlidesDeleteSlide_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if strings.HasSuffix(r.URL.Path, ":batchUpdate") && r.Method == http.MethodPost {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"presentationId": "pres1",
				"replies":        []any{},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	svc, err := slides.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("slides.NewService: %v", err)
	}

	flags := &RootFlags{Account: "a@b.com", Force: true}
	var out bytes.Buffer
	ctx := withSlidesTestService(newCmdRuntimeJSONOutputContext(t, &out, io.Discard), svc)
	cmd := &SlidesDeleteSlideCmd{
		PresentationID: "pres1",
		SlideID:        "slide_abc",
	}
	if err := cmd.Run(ctx, flags); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var got struct {
		PresentationID string `json:"presentationId"`
		SlideObjectID  string `json:"slideObjectId"`
		Deleted        bool   `json:"deleted"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("JSON parse: %v\noutput: %q", err, out.String())
	}
	if got.PresentationID != "pres1" || got.SlideObjectID != "slide_abc" || !got.Deleted {
		t.Fatalf("unexpected JSON output: %#v", got)
	}
}

func TestSlidesDeleteSlide_NoInputRequiresForce(t *testing.T) {
	ctx := withSlidesTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*slides.Service, error) {
			t.Fatal("slides service should not be created without --force")
			return nil, context.Canceled
		},
	)

	flags := &RootFlags{Account: "a@b.com", NoInput: true}

	cmd := &SlidesDeleteSlideCmd{
		PresentationID: "pres1",
		SlideID:        "slide_abc",
	}
	err := cmd.Run(ctx, flags)
	if err == nil || !strings.Contains(err.Error(), "without --force") {
		t.Fatalf("expected force error, got: %v", err)
	}
}

func TestSlidesDeleteSlide_EmptyID(t *testing.T) {
	flags := &RootFlags{Account: "a@b.com"}
	ctx := withSlidesTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*slides.Service, error) {
			t.Fatal("slides service should not be created")
			return nil, context.Canceled
		},
	)

	cmd := &SlidesDeleteSlideCmd{
		PresentationID: "pres1",
		SlideID:        "  ",
	}
	err := cmd.Run(ctx, flags)
	if err == nil || !strings.Contains(err.Error(), "empty slideId") {
		t.Fatalf("expected empty slideId error, got: %v", err)
	}
}
