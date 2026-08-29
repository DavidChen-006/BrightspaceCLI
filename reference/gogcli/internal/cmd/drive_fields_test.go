package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"google.golang.org/api/drive/v3"
)

type driveFieldsHit struct {
	lastFields atomic.Value // string
}

func newDriveFieldsTestServer(t *testing.T, handler func(r *http.Request) map[string]any, hit *driveFieldsHit) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hit != nil {
			hit.lastFields.Store(r.URL.Query().Get("fields"))
		}
		body := handler(r)
		if body == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
}

// TestDriveGet_FieldsFlag proves --fields on `gog drive get` maps to the
// Drive API fields parameter, enabling requests for fields the hard-coded
// default did not include (e.g. thumbnailLink). Closes #486.
func TestDriveGet_FieldsFlag(t *testing.T) {
	t.Parallel()

	hit := &driveFieldsHit{}
	srv := newDriveFieldsTestServer(t, func(r *http.Request) map[string]any {
		if !strings.Contains(r.URL.Path, "/files/f1") {
			return nil
		}
		return map[string]any{
			"id":            "f1",
			"name":          "photo.png",
			"mimeType":      "image/png",
			"thumbnailLink": "https://drive.google.com/thumb/f1",
		}
	}, hit)
	defer srv.Close()
	svc := newGoogleTestServiceWithEndpoint(t, srv.Client(), srv.URL+"/", drive.NewService)

	var stdout bytes.Buffer
	ctx := newCmdRuntimeJSONOutputContext(t, &stdout, io.Discard)
	ctx = withDriveTestService(ctx, svc)
	flags := &RootFlags{Account: "a@b.com"}

	if err := runKong(t, &DriveGetCmd{}, []string{"f1", "--fields", "id,name,thumbnailLink"}, ctx, flags); err != nil {
		t.Fatalf("run: %v", err)
	}

	got, _ := hit.lastFields.Load().(string)
	if !strings.Contains(got, "thumbnailLink") {
		t.Fatalf("expected Drive API fields param to contain thumbnailLink, got: %q", got)
	}
	// Output should wrap under "file" per existing drive get -j contract.
	var envelope map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatalf("invalid JSON: %v\nraw: %s", err, stdout.String())
	}
	file, ok := envelope["file"].(map[string]any)
	if !ok {
		t.Fatalf("expected file envelope, got: %v", envelope)
	}
	if file["thumbnailLink"] != "https://drive.google.com/thumb/f1" {
		t.Fatalf("expected thumbnailLink passthrough, got: %v", file["thumbnailLink"])
	}
}

// TestDriveLs_FieldsFlag proves --fields on `gog drive ls` maps through to
// the Drive API list fields parameter so consumers can request fields not
// in the hard-coded default set.
func TestDriveLs_FieldsFlag(t *testing.T) {
	t.Parallel()

	hit := &driveFieldsHit{}
	srv := newDriveFieldsTestServer(t, func(r *http.Request) map[string]any {
		path := strings.TrimPrefix(r.URL.Path, "/drive/v3")
		if path != "/files" {
			return nil
		}
		return map[string]any{
			"files": []map[string]any{
				{
					"id":            "f1",
					"name":          "photo.png",
					"mimeType":      "image/png",
					"thumbnailLink": "https://drive.google.com/thumb/f1",
				},
			},
		}
	}, hit)
	defer srv.Close()
	svc := newGoogleTestServiceWithEndpoint(t, srv.Client(), srv.URL+"/", drive.NewService)

	var stdout bytes.Buffer
	ctx := newCmdRuntimeJSONOutputContext(t, &stdout, io.Discard)
	ctx = withDriveTestService(ctx, svc)
	flags := &RootFlags{Account: "a@b.com"}

	if err := runKong(t, &DriveLsCmd{}, []string{"--fields", "files(id,name,thumbnailLink)"}, ctx, flags); err != nil {
		t.Fatalf("run: %v", err)
	}

	got, _ := hit.lastFields.Load().(string)
	if !strings.Contains(got, "thumbnailLink") {
		t.Fatalf("expected Drive API fields param to contain thumbnailLink, got: %q", got)
	}
	if !strings.Contains(stdout.String(), "thumbnailLink") {
		t.Fatalf("expected thumbnailLink in output, got: %q", stdout.String())
	}
}
