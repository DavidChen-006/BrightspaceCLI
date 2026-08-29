package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/option"
	"google.golang.org/api/people/v1"
)

var errUnexpectedContactsServiceCall = errors.New("unexpected contacts service call")

func TestExecute_ContactsList_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/people/me/connections") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"connections": []map[string]any{
				{
					"resourceName": "people/c1",
					"names":        []map[string]any{{"displayName": "Ada Lovelace"}},
					"emailAddresses": []map[string]any{
						{"value": "ada@example.com"},
					},
					"birthdays": []map[string]any{
						{"date": map[string]any{"year": 1815, "month": 12, "day": 10}},
					},
				},
			},
			"nextPageToken": "npt",
		})
	}))
	defer srv.Close()

	svc, err := people.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	result := executeWithPeopleContactsTestService(t, []string{"--json", "--account", "a@b.com", "contacts", "list", "--max", "1"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		Contacts []struct {
			Resource string `json:"resource"`
			Name     string `json:"name"`
			Email    string `json:"email"`
			Birthday string `json:"birthday"`
		} `json:"contacts"`
		NextPageToken string `json:"nextPageToken"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out)
	}
	if parsed.NextPageToken != "npt" || len(parsed.Contacts) != 1 {
		t.Fatalf("unexpected: %#v", parsed)
	}
	if parsed.Contacts[0].Resource != "people/c1" || parsed.Contacts[0].Name != "Ada Lovelace" || parsed.Contacts[0].Email != "ada@example.com" {
		t.Fatalf("unexpected contact: %#v", parsed.Contacts[0])
	}
	if parsed.Contacts[0].Birthday != "1815-12-10" {
		t.Fatalf("unexpected birthday: %#v", parsed.Contacts[0])
	}
}

func TestExecute_ContactsInvalidMaxFailsBeforeService(t *testing.T) {
	factory := func(context.Context, string) (*people.Service, error) {
		t.Fatalf("expected max validation to fail before creating contacts service")
		return nil, errUnexpectedContactsServiceCall
	}

	testCases := [][]string{
		{"--account", "a@b.com", "contacts", "list", "--max", "0"},
		{"--account", "a@b.com", "contacts", "list", "--max=-1"},
		{"--account", "a@b.com", "contacts", "search", "alice", "--max", "0"},
		{"--account", "a@b.com", "contacts", "search", "alice", "--max=-1"},
	}
	for _, args := range testCases {
		t.Run(strings.Join(args[2:], "_"), func(t *testing.T) {
			err := executeWithPeopleTestServices(t, args, peopleTestServices{Contacts: factory}).err
			var exitErr *ExitError
			if !errors.As(err, &exitErr) || exitErr.Code != 2 || !strings.Contains(err.Error(), "max must be > 0") {
				t.Fatalf("unexpected err: %v", err)
			}
		})
	}
}

func TestExecute_ContactsGet_ByEmail_JSON(t *testing.T) {
	var queries []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "people:searchContacts") {
			http.NotFound(w, r)
			return
		}
		queries = append(queries, r.URL.Query().Get("query"))
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("query") == "" {
			_ = json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{
					"person": map[string]any{
						"resourceName": "people/c1",
						"names":        []map[string]any{{"displayName": "Ada Lovelace"}},
						"emailAddresses": []map[string]any{
							{"value": "ada@example.com"},
						},
					},
				},
			},
		})
	}))
	defer srv.Close()

	svc, err := people.NewService(context.Background(),
		option.WithoutAuthentication(),
		option.WithHTTPClient(srv.Client()),
		option.WithEndpoint(srv.URL+"/"),
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	result := executeWithPeopleContactsTestService(t, []string{"--json", "--account", "a@b.com", "contacts", "get", "ada@example.com"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		Contact struct {
			ResourceName string `json:"resourceName"`
		} `json:"contact"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out)
	}
	if parsed.Contact.ResourceName != "people/c1" {
		t.Fatalf("unexpected contact: %#v", parsed.Contact)
	}
	if got, want := strings.Join(queries, ","), ",ada@example.com"; got != want {
		t.Fatalf("search queries = %q, want %q", got, want)
	}
}

func TestExecute_ContactsSearch_WarmsCache(t *testing.T) {
	var queries []string
	svc := newPeopleSearchTestService(t, "people:searchContacts", "people/c1", "Ada Lovelace", "ada@example.com", &queries)

	result := executeWithPeopleContactsTestService(t, []string{"--json", "--account", "a@b.com", "contacts", "search", "Ada"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		Contacts []struct {
			Resource string `json:"resource"`
		} `json:"contacts"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out)
	}
	if len(parsed.Contacts) != 1 || parsed.Contacts[0].Resource != "people/c1" {
		t.Fatalf("unexpected contacts: %#v", parsed.Contacts)
	}
	if got, want := strings.Join(queries, ","), ",Ada"; got != want {
		t.Fatalf("search queries = %q, want %q", got, want)
	}
}

func TestExecute_ContactsOtherSearch_WarmsCache(t *testing.T) {
	var queries []string
	svc := newPeopleSearchTestService(t, "otherContacts:search", "otherContacts/c1", "Other Ada", "other@example.com", &queries)

	result := executeWithPeopleOtherTestService(t, []string{"--json", "--account", "a@b.com", "contacts", "other", "search", "Other"}, svc)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout

	var parsed struct {
		Contacts []struct {
			Resource string `json:"resource"`
		} `json:"contacts"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("json parse: %v\nout=%q", err, out)
	}
	if len(parsed.Contacts) != 1 || parsed.Contacts[0].Resource != "otherContacts/c1" {
		t.Fatalf("unexpected contacts: %#v", parsed.Contacts)
	}
	if got, want := strings.Join(queries, ","), ",Other"; got != want {
		t.Fatalf("search queries = %q, want %q", got, want)
	}
}
