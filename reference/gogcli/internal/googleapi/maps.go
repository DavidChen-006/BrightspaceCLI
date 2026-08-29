package googleapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const defaultMapsBaseURL = "https://maps.googleapis.com/maps/api"

var (
	errMissingMapsAPIKey = errors.New("missing Maps API key")
	errMapsAPI           = errors.New("maps API error")
)

type MapsClient struct {
	apiKey  string
	baseURL string
	client  *http.Client
}

type MapsClientOption func(*MapsClient)

func WithMapsBaseURL(baseURL string) MapsClientOption {
	return func(c *MapsClient) {
		if strings.TrimSpace(baseURL) != "" {
			c.baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
		}
	}
}

func NewMapsClient(apiKey string, opts ...MapsClientOption) *MapsClient {
	c := &MapsClient{
		apiKey:  strings.TrimSpace(apiKey),
		baseURL: defaultMapsBaseURL,
		client:  &http.Client{Timeout: 10 * time.Second},
	}
	for _, opt := range opts {
		opt(c)
	}

	return c
}

type MapsDirectionsOptions struct {
	Mode     string
	Language string
	Region   string
}

type MapsDistanceMatrixOptions struct {
	Mode     string
	Units    string
	Language string
	Region   string
}

type MapsGeocodeOptions struct {
	Language string
	Region   string
}

type MapsDirectionsResponse struct {
	Status       string      `json:"status,omitempty"`
	ErrorMessage string      `json:"error_message,omitempty"`
	Routes       []MapsRoute `json:"routes,omitempty"`
}

type MapsRoute struct {
	Summary          string               `json:"summary,omitempty"`
	Legs             []MapsRouteLeg       `json:"legs,omitempty"`
	OverviewPolyline MapsOverviewPolyline `json:"overview_polyline,omitempty"`
}

type MapsRouteLeg struct {
	Distance     MapsTextValue `json:"distance,omitempty"`
	Duration     MapsTextValue `json:"duration,omitempty"`
	StartAddress string        `json:"start_address,omitempty"`
	EndAddress   string        `json:"end_address,omitempty"`
}

type MapsTextValue struct {
	Text  string `json:"text,omitempty"`
	Value int64  `json:"value,omitempty"`
}

type MapsOverviewPolyline struct {
	Points string `json:"points,omitempty"`
}

type MapsDistanceMatrixResponse struct {
	Status          string                  `json:"status,omitempty"`
	ErrorMessage    string                  `json:"error_message,omitempty"`
	OriginAddresses []string                `json:"origin_addresses,omitempty"`
	DestAddresses   []string                `json:"destination_addresses,omitempty"`
	Rows            []MapsDistanceMatrixRow `json:"rows,omitempty"`
}

type MapsDistanceMatrixRow struct {
	Elements []MapsDistanceMatrixElement `json:"elements,omitempty"`
}

type MapsDistanceMatrixElement struct {
	Status   string        `json:"status,omitempty"`
	Distance MapsTextValue `json:"distance,omitempty"`
	Duration MapsTextValue `json:"duration,omitempty"`
}

type MapsGeocodeResponse struct {
	Status       string              `json:"status,omitempty"`
	ErrorMessage string              `json:"error_message,omitempty"`
	Results      []MapsGeocodeResult `json:"results,omitempty"`
}

type MapsGeocodeResult struct {
	FormattedAddress string              `json:"formatted_address,omitempty"`
	PlaceID          string              `json:"place_id,omitempty"`
	Types            []string            `json:"types,omitempty"`
	Geometry         MapsGeocodeGeometry `json:"geometry,omitempty"`
}

type MapsGeocodeGeometry struct {
	Location     MapsLatLng `json:"location,omitempty"`
	LocationType string     `json:"location_type,omitempty"`
}

type MapsLatLng struct {
	Lat float64 `json:"lat,omitempty"`
	Lng float64 `json:"lng,omitempty"`
}

func (c *MapsClient) Directions(ctx context.Context, origin, destination string, opts MapsDirectionsOptions) (*MapsDirectionsResponse, error) {
	q := url.Values{}
	q.Set("origin", strings.TrimSpace(origin))
	q.Set("destination", strings.TrimSpace(destination))

	if strings.TrimSpace(opts.Mode) != "" {
		q.Set("mode", strings.TrimSpace(opts.Mode))
	}

	addMapsCommonOptions(q, opts.Language, opts.Region)

	var out MapsDirectionsResponse
	if err := c.doGet(ctx, "/directions/json", q, &out); err != nil {
		return nil, err
	}

	return &out, mapsStatusError(out.Status, out.ErrorMessage)
}

func (c *MapsClient) DistanceMatrix(ctx context.Context, origins, destinations []string, opts MapsDistanceMatrixOptions) (*MapsDistanceMatrixResponse, error) {
	q := url.Values{}
	q.Set("origins", strings.Join(trimNonEmpty(origins), "|"))
	q.Set("destinations", strings.Join(trimNonEmpty(destinations), "|"))

	if strings.TrimSpace(opts.Mode) != "" {
		q.Set("mode", strings.TrimSpace(opts.Mode))
	}

	if strings.TrimSpace(opts.Units) != "" {
		q.Set("units", strings.TrimSpace(opts.Units))
	}

	addMapsCommonOptions(q, opts.Language, opts.Region)

	var out MapsDistanceMatrixResponse
	if err := c.doGet(ctx, "/distancematrix/json", q, &out); err != nil {
		return nil, err
	}

	return &out, mapsStatusError(out.Status, out.ErrorMessage)
}

func (c *MapsClient) Geocode(ctx context.Context, address string, opts MapsGeocodeOptions) (*MapsGeocodeResponse, error) {
	q := url.Values{}
	q.Set("address", strings.TrimSpace(address))

	addMapsCommonOptions(q, opts.Language, opts.Region)

	var out MapsGeocodeResponse
	if err := c.doGet(ctx, "/geocode/json", q, &out); err != nil {
		return nil, err
	}

	return &out, mapsStatusError(out.Status, out.ErrorMessage)
}

func (c *MapsClient) ReverseGeocode(ctx context.Context, latlng string, opts MapsGeocodeOptions) (*MapsGeocodeResponse, error) {
	q := url.Values{}
	q.Set("latlng", strings.TrimSpace(latlng))

	addMapsCommonOptions(q, opts.Language, opts.Region)

	var out MapsGeocodeResponse
	if err := c.doGet(ctx, "/geocode/json", q, &out); err != nil {
		return nil, err
	}

	return &out, mapsStatusError(out.Status, out.ErrorMessage)
}

func (c *MapsClient) doGet(ctx context.Context, path string, q url.Values, out any) error {
	if strings.TrimSpace(c.apiKey) == "" {
		return errMissingMapsAPIKey
	}

	q.Set("key", c.apiKey)

	endpoint := c.baseURL + path + "?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("build Maps API request: %w", err)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("send Maps API request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return fmt.Errorf("read Maps API response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%w %d: %s", errMapsAPI, resp.StatusCode, strings.TrimSpace(string(body)))
	}

	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode Maps API response: %w", err)
	}

	return nil
}

func addMapsCommonOptions(q url.Values, language, region string) {
	if strings.TrimSpace(language) != "" {
		q.Set("language", strings.TrimSpace(language))
	}

	if strings.TrimSpace(region) != "" {
		q.Set("region", strings.TrimSpace(region))
	}
}

func mapsStatusError(status, message string) error {
	status = strings.TrimSpace(status)
	if status == "" || status == "OK" || status == "ZERO_RESULTS" {
		return nil
	}

	if strings.TrimSpace(message) != "" {
		return fmt.Errorf("%w %s: %s", errMapsAPI, status, message)
	}

	return fmt.Errorf("%w %s", errMapsAPI, status)
}

func trimNonEmpty(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			out = append(out, strings.TrimSpace(value))
		}
	}

	return out
}
