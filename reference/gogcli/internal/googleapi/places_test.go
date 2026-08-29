package googleapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPlacesTextSearch(t *testing.T) {
	var gotFieldMask, gotAPIKey string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/places:searchText" {
			t.Fatalf("path = %q", r.URL.Path)
		}

		gotFieldMask = r.Header.Get("X-Goog-FieldMask")
		gotAPIKey = r.Header.Get("X-Goog-Api-Key")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"places":[{"id":"ChIJ123","displayName":{"text":"Cafe"},"formattedAddress":"1 Main St","googleMapsUri":"https://maps.google.com/?cid=1"}]}`))
	}))
	defer srv.Close()

	client := NewPlacesClient("test-key", WithPlacesBaseURL(srv.URL), WithPlacesHTTPClient(srv.Client()))

	place, err := client.TextSearch(context.Background(), "cafe near me", PlacesLookupOptions{LanguageCode: "en", RegionCode: "US"})
	if err != nil {
		t.Fatalf("TextSearch: %v", err)
	}

	if gotAPIKey != "test-key" {
		t.Fatalf("api key header = %q", gotAPIKey)
	}

	if !strings.Contains(gotFieldMask, "places.id") || strings.Contains(gotFieldMask, "reviews") {
		t.Fatalf("field mask = %q", gotFieldMask)
	}

	if place.ID != "ChIJ123" || place.Name != "Cafe" || place.FormattedAddress != "1 Main St" || place.GoogleMapsURI == "" {
		t.Fatalf("unexpected place: %#v", place)
	}
}

func TestPlacesDetails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/places/ChIJ123" {
			t.Fatalf("path = %q", r.URL.Path)
		}

		if got := r.URL.Query().Get("regionCode"); got != "US" {
			t.Fatalf("regionCode = %q", got)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"ChIJ123","displayName":{"text":"Cafe"},"formattedAddress":"1 Main St"}`))
	}))
	defer srv.Close()

	client := NewPlacesClient("test-key", WithPlacesBaseURL(srv.URL), WithPlacesHTTPClient(srv.Client()))

	place, err := client.Details(context.Background(), "places/ChIJ123", PlacesLookupOptions{RegionCode: "US"})
	if err != nil {
		t.Fatalf("Details: %v", err)
	}

	if place.ID != "ChIJ123" || place.Name != "Cafe" {
		t.Fatalf("unexpected place: %#v", place)
	}
}

func TestPlacesAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":403,"status":"PERMISSION_DENIED","message":"API disabled"}}`))
	}))
	defer srv.Close()

	client := NewPlacesClient("test-key", WithPlacesBaseURL(srv.URL), WithPlacesHTTPClient(srv.Client()))
	_, err := client.Details(context.Background(), "ChIJ123", PlacesLookupOptions{})

	if err == nil || !strings.Contains(err.Error(), "PERMISSION_DENIED") {
		t.Fatalf("expected parsed API error, got %v", err)
	}
}
