package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestDriveURLCmd_TextAndJSON(t *testing.T) {
	svc, closeSrv := newDriveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var id string
		switch {
		case strings.HasPrefix(r.URL.Path, "/drive/v3/files/"):
			id = strings.TrimPrefix(r.URL.Path, "/drive/v3/files/")
		case strings.HasPrefix(r.URL.Path, "/files/"):
			id = strings.TrimPrefix(r.URL.Path, "/files/")
		default:
			http.NotFound(w, r)
			return
		}
		var web string
		switch id {
		case "id1":
			web = "https://example.com/id1"
		case "id2":
			web = "" // force fallback URL
		default:
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":          id,
			"webViewLink": web,
		})
	}))
	defer closeSrv()

	flags := &RootFlags{Account: "a@b.com"}

	var outBuf bytes.Buffer
	ctx := withDriveTestService(newCmdRuntimeOutputContext(t, &outBuf, io.Discard), svc)

	cmd := &DriveURLCmd{}
	if err := runKong(t, cmd, []string{"id1", "id2"}, ctx, flags); err != nil {
		t.Fatalf("execute: %v", err)
	}
	gotText := outBuf.String()
	if !strings.Contains(gotText, "id1\thttps://example.com/id1") {
		t.Fatalf("missing id1 line: %q", gotText)
	}
	if !strings.Contains(gotText, "id2\thttps://drive.google.com/file/d/id2/view") {
		t.Fatalf("missing id2 fallback line: %q", gotText)
	}

	var jsonOut bytes.Buffer
	ctx2 := withDriveTestService(newCmdRuntimeJSONOutputContext(t, &jsonOut, io.Discard), svc)
	cmd2 := &DriveURLCmd{}
	if err := runKong(t, cmd2, []string{"id1", "id2"}, ctx2, flags); err != nil {
		t.Fatalf("execute: %v", err)
	}

	var parsed struct {
		URLs []struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		} `json:"urls"`
	}
	if err := json.Unmarshal(jsonOut.Bytes(), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, jsonOut.String())
	}
	if len(parsed.URLs) != 2 {
		t.Fatalf("unexpected urls: %#v", parsed.URLs)
	}
	if parsed.URLs[0].ID != "id1" || parsed.URLs[0].URL != "https://example.com/id1" {
		t.Fatalf("unexpected id1: %#v", parsed.URLs[0])
	}
	if parsed.URLs[1].ID != "id2" || parsed.URLs[1].URL != "https://drive.google.com/file/d/id2/view" {
		t.Fatalf("unexpected id2: %#v", parsed.URLs[1])
	}
}
