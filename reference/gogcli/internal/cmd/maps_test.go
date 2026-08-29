package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMapsPlacesSearch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/places:searchText" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("X-Goog-Api-Key"); got != "test-key" {
			t.Fatalf("missing API key header: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"places": []map[string]any{{
				"id":               "ChIJ123",
				"displayName":      map[string]any{"text": "Cafe"},
				"formattedAddress": "1 Main St",
				"googleMapsUri":    "https://maps.example/cafe",
			}},
		})
	}))
	defer srv.Close()
	t.Setenv("GOG_PLACES_API_KEY", "test-key")
	t.Setenv("GOG_PLACES_BASE_URL", srv.URL)

	var stdout bytes.Buffer
	if err := (&MapsPlacesSearchCmd{Query: []string{"cafe"}}).Run(
		newCmdRuntimeJSONOutputContext(t, &stdout, io.Discard),
		&RootFlags{},
	); err != nil {
		t.Fatalf("Run: %v", err)
	}
	out := stdout.String()
	if !strings.Contains(out, "ChIJ123") || !strings.Contains(out, "Cafe") || !strings.Contains(out, "maps.example") {
		t.Fatalf("unexpected output: %s", out)
	}
}

func TestMapsDirections(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/directions/json" {
			http.NotFound(w, r)
			return
		}
		requireQuery(t, r, "key", "test-key")
		requireQuery(t, r, "origin", "Barcelona")
		requireQuery(t, r, "destination", "Blanes")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "OK",
			"routes": []map[string]any{{
				"summary": "C-32",
				"legs": []map[string]any{{
					"start_address": "Barcelona",
					"end_address":   "Blanes",
					"distance":      map[string]any{"text": "70 km", "value": 70000},
					"duration":      map[string]any{"text": "1 hour", "value": 3600},
				}},
			}},
		})
	}))
	defer srv.Close()
	t.Setenv("GOG_PLACES_API_KEY", "test-key")
	t.Setenv("GOG_MAPS_BASE_URL", srv.URL)

	var stdout bytes.Buffer
	err := (&MapsDirectionsCmd{Origin: "Barcelona", Destination: "Blanes"}).Run(
		newCmdRuntimeJSONOutputContext(t, &stdout, io.Discard),
		&RootFlags{},
	)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	out := stdout.String()
	if !strings.Contains(out, "C-32") || !strings.Contains(out, "70 km") {
		t.Fatalf("unexpected output: %s", out)
	}
}

func TestMapsDirectionsRejectsInvalidModeBeforeAPIKey(t *testing.T) {
	t.Setenv("GOG_PLACES_API_KEY", "")
	err := (&MapsDirectionsCmd{
		Origin:      "Barcelona",
		Destination: "Blanes",
		Mode:        "hoverboard",
	}).Run(newCmdJSONContext(t), &RootFlags{})
	if err == nil || !strings.Contains(err.Error(), "invalid --mode") {
		t.Fatalf("expected invalid mode error, got %v", err)
	}
}

func TestMapsDistanceRejectsInvalidUnitsBeforeAPIKey(t *testing.T) {
	t.Setenv("GOG_PLACES_API_KEY", "")
	err := (&MapsDistanceCmd{
		Origins:      "Barcelona",
		Destinations: "Blanes",
		Units:        "parsecs",
	}).Run(newCmdJSONContext(t), &RootFlags{})
	if err == nil || !strings.Contains(err.Error(), "invalid --units") {
		t.Fatalf("expected invalid units error, got %v", err)
	}
}

func TestMapsReverseGeocodeRejectsInvalidLatLngBeforeAPIKey(t *testing.T) {
	t.Setenv("GOG_PLACES_API_KEY", "")
	for _, tc := range []struct {
		name string
		lat  string
		lng  string
		want string
	}{
		{name: "lat parse", lat: "north", lng: "2.1", want: "invalid --lat"},
		{name: "lng parse", lat: "41.0", lng: "east", want: "invalid --lng"},
		{name: "lat nan", lat: "NaN", lng: "2.1", want: "invalid --lat"},
		{name: "lng inf", lat: "41.0", lng: "+Inf", want: "invalid --lng"},
		{name: "lat range", lat: "91", lng: "2.1", want: "invalid --lat"},
		{name: "lng range", lat: "41.0", lng: "181", want: "invalid --lng"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := (&MapsReverseGeocodeCmd{Lat: tc.lat, Lng: tc.lng}).Run(newCmdJSONContext(t), &RootFlags{})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q error, got %v", tc.want, err)
			}
		})
	}
}

func TestMapsGeocode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/geocode/json" {
			http.NotFound(w, r)
			return
		}
		requireQuery(t, r, "address", "Carrer Major, Blanes")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "OK",
			"results": []map[string]any{{
				"formatted_address": "Carrer Major, Blanes, Girona, Spain",
				"place_id":          "place-1",
				"geometry": map[string]any{
					"location":      map[string]any{"lat": 41.674, "lng": 2.792},
					"location_type": "ROOFTOP",
				},
			}},
		})
	}))
	defer srv.Close()
	t.Setenv("GOG_PLACES_API_KEY", "test-key")
	t.Setenv("GOG_MAPS_BASE_URL", srv.URL)

	var stdout bytes.Buffer
	err := (&MapsGeocodeCmd{Address: []string{"Carrer", "Major,", "Blanes"}}).Run(
		newCmdRuntimeJSONOutputContext(t, &stdout, io.Discard),
		&RootFlags{},
	)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	out := stdout.String()
	if !strings.Contains(out, "place-1") || !strings.Contains(out, "41.674") {
		t.Fatalf("unexpected output: %s", out)
	}
}
