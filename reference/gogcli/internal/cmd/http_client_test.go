package cmd

import (
	"context"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/openclaw/gogcli/internal/googleapi"
	"github.com/openclaw/gogcli/internal/tracking"
	"github.com/openclaw/gogcli/internal/ui"
)

type stubRoundTripper struct {
	fn func(*http.Request) (*http.Response, error)
}

func (s stubRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return s.fn(req)
}

func swapOutboundHTTPClient(t *testing.T, client *http.Client) {
	t.Helper()
	old := outboundHTTPClient
	outboundHTTPClient = client
	t.Cleanup(func() { outboundHTTPClient = old })
}

func TestOutboundHTTPClientIsBounded(t *testing.T) {
	if outboundHTTPClient == http.DefaultClient {
		t.Fatal("outboundHTTPClient is http.DefaultClient")
	}
	tr, ok := outboundHTTPClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", outboundHTTPClient.Transport)
	}
	if tr.ResponseHeaderTimeout == 0 {
		t.Fatal("ResponseHeaderTimeout is 0")
	}
}

func TestQueryByTrackingIDUsesOutboundHTTPClient(t *testing.T) {
	var saw string
	swapOutboundHTTPClient(t, &http.Client{
		Transport: stubRoundTripper{fn: func(req *http.Request) (*http.Response, error) {
			saw = req.URL.String()
			return nil, errors.New("sentinel-outbound")
		}},
	})

	u, err := ui.New(ui.Options{Stdout: io.Discard, Stderr: io.Discard, Color: "never"})
	if err != nil {
		t.Fatalf("ui.New: %v", err)
	}
	cmd := &GmailTrackOpensCmd{TrackingID: "tid-1"}
	err = cmd.queryByTrackingID(context.Background(), &tracking.Config{WorkerURL: "http://tracker.example"}, u)
	if err == nil || !strings.Contains(err.Error(), "sentinel-outbound") {
		t.Fatalf("queryByTrackingID error = %v", err)
	}
	if saw != "http://tracker.example/q/tid-1" {
		t.Fatalf("request URL = %q", saw)
	}
}

func TestQueryAdminUsesOutboundHTTPClient(t *testing.T) {
	var sawAuth string
	swapOutboundHTTPClient(t, &http.Client{
		Transport: stubRoundTripper{fn: func(req *http.Request) (*http.Response, error) {
			sawAuth = req.Header.Get("Authorization")
			return nil, errors.New("sentinel-outbound")
		}},
	})

	u, err := ui.New(ui.Options{Stdout: io.Discard, Stderr: io.Discard, Color: "never"})
	if err != nil {
		t.Fatalf("ui.New: %v", err)
	}
	cmd := &GmailTrackOpensCmd{}
	err = cmd.queryAdmin(context.Background(), &tracking.Config{WorkerURL: "http://tracker.example", AdminKey: "secret"}, u)
	if err == nil || !strings.Contains(err.Error(), "sentinel-outbound") {
		t.Fatalf("queryAdmin error = %v", err)
	}
	if sawAuth != "Bearer secret" {
		t.Fatalf("Authorization = %q", sawAuth)
	}
}

func TestDownloadSlidesThumbnailUsesOutboundHTTPClient(t *testing.T) {
	swapOutboundHTTPClient(t, &http.Client{
		Transport: stubRoundTripper{fn: func(req *http.Request) (*http.Response, error) {
			return nil, errors.New("sentinel-outbound")
		}},
	})

	_, _, err := downloadSlidesThumbnail(context.Background(), "http://cdn.example/thumb.png", filepath.Join(t.TempDir(), "t.png"), true)
	if err == nil || !strings.Contains(err.Error(), "sentinel-outbound") {
		t.Fatalf("downloadSlidesThumbnail error = %v", err)
	}
}

func TestNewBoundedHTTPClientMatchesAuthenticatedTransportTimeout(t *testing.T) {
	client := googleapi.NewBoundedHTTPClient()
	if client == http.DefaultClient {
		t.Fatal("NewBoundedHTTPClient returned DefaultClient")
	}
	tr, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", client.Transport)
	}
	if tr.ResponseHeaderTimeout == 0 {
		t.Fatal("ResponseHeaderTimeout is 0")
	}
}
