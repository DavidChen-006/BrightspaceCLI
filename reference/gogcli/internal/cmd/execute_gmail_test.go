package cmd

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExecute_GmailSearch_JSON(t *testing.T) {
	srv := httptest.NewServer(gmailSearchTestHandler())
	defer srv.Close()

	result := executeWithGmailTestService(
		t,
		[]string{"--json", "--account", "a@b.com", "gmail", "search", "newer_than:7d", "--max", "1", "--timezone", "UTC"},
		newGmailServiceFromServer(t, srv),
	)
	if result.err != nil {
		t.Fatalf("Execute: %v\nstderr=%q", result.err, result.stderr)
	}

	var parsed struct {
		Threads []struct {
			ID           string   `json:"id"`
			Date         string   `json:"date"`
			From         string   `json:"from"`
			Subject      string   `json:"subject"`
			Labels       []string `json:"labels"`
			MessageCount int      `json:"messageCount"`
		} `json:"threads"`
		NextPageToken string `json:"nextPageToken"`
	}
	if err := json.Unmarshal([]byte(result.stdout), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, result.stdout)
	}
	if parsed.NextPageToken != "npt" || len(parsed.Threads) != 1 {
		t.Fatalf("unexpected: %#v", parsed)
	}
	if parsed.Threads[0].ID != "t1" || parsed.Threads[0].Subject != "Hello" {
		t.Fatalf("unexpected thread: %#v", parsed.Threads[0])
	}
	if parsed.Threads[0].MessageCount != 1 {
		t.Fatalf("unexpected messageCount: %d", parsed.Threads[0].MessageCount)
	}
	if parsed.Threads[0].Date != "2006-01-02 22:04" {
		t.Fatalf("unexpected date: %q", parsed.Threads[0].Date)
	}
	if len(parsed.Threads[0].Labels) != 1 || parsed.Threads[0].Labels[0] != "INBOX" {
		t.Fatalf("unexpected labels: %#v", parsed.Threads[0].Labels)
	}
}

func TestExecute_GmailURL_JSON(t *testing.T) {
	result := executeWithTestRuntime(t, []string{"--json", "--account", "a@b.com", "gmail", "url", "t1"}, nil)
	if result.err != nil {
		t.Fatalf("Execute: %v\nstderr=%q", result.err, result.stderr)
	}
	var parsed struct {
		URLs []struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		} `json:"urls"`
	}
	if err := json.Unmarshal([]byte(result.stdout), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, result.stdout)
	}
	if len(parsed.URLs) != 1 || parsed.URLs[0].ID != "t1" || !strings.Contains(parsed.URLs[0].URL, "#all/t1") {
		t.Fatalf("unexpected urls: %#v", parsed.URLs)
	}
}
