package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/option"
	"google.golang.org/api/people/v1"
)

func TestExecute_ContactsMoreCommands_JSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.Contains(path, "people/c1") && r.Method == http.MethodGet && !strings.Contains(path, ":"):
			// people.get (used by contacts update)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"resourceName": "people/c1",
				"names":        []map[string]any{{"givenName": "Ada", "familyName": "Lovelace"}},
			})
			return
		case strings.Contains(path, "people:searchContacts") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []map[string]any{
					{
						"person": map[string]any{
							"resourceName": "people/c1",
							"names":        []map[string]any{{"displayName": "Ada"}},
							"emailAddresses": []map[string]any{
								{"value": "ada@example.com"},
							},
							"phoneNumbers": []map[string]any{{"value": "+1"}},
						},
					},
				},
			})
			return
		case strings.Contains(path, "people:createContact") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"resourceName": "people/c1",
				"names":        []map[string]any{{"displayName": "Ada"}},
			})
			return
		case strings.Contains(path, "people/c1") && strings.Contains(path, ":updateContact") && (r.Method == http.MethodPatch || r.Method == http.MethodPost):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"resourceName": "people/c1",
				"names":        []map[string]any{{"displayName": "Ada Updated"}},
			})
			return
		case strings.Contains(path, "people/c1:deleteContact") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
			return
		case strings.Contains(path, "people:listDirectoryPeople") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"people":        []map[string]any{{"resourceName": "people/d1", "names": []map[string]any{{"displayName": "Dir"}}}},
				"nextPageToken": "npt",
			})
			return
		case strings.Contains(path, "people:searchDirectoryPeople") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"people": []map[string]any{{"resourceName": "people/d2", "names": []map[string]any{{"displayName": "Dir2"}}}},
			})
			return
		case strings.Contains(path, "otherContacts:search") && r.Method == http.MethodGet:
			if got := r.URL.Query().Get("readMask"); got != contactsOtherReadMask {
				t.Fatalf("other search readMask = %q, want %q", got, contactsOtherReadMask)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []map[string]any{
					{
						"person": map[string]any{
							"resourceName": "people/o1",
							"names":        []map[string]any{{"displayName": "Other"}},
						},
					},
				},
			})
			return
		case strings.Contains(path, "/otherContacts") && r.Method == http.MethodGet:
			// otherContacts.list
			if got := r.URL.Query().Get("readMask"); got != contactsOtherReadMask {
				t.Fatalf("other list readMask = %q, want %q", got, contactsOtherReadMask)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"otherContacts": []map[string]any{
					{"resourceName": "people/o1", "names": []map[string]any{{"displayName": "Other"}}},
				},
				"nextPageToken": "npt",
			})
			return
		default:
			http.NotFound(w, r)
			return
		}
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

	run := func(name string, args ...string) {
		t.Helper()
		result := executeWithAllPeopleTestServices(t, args, svc)
		if result.err != nil {
			t.Fatalf("%s: %v", name, result.err)
		}
	}
	run("search", "--json", "--account", "a@b.com", "contacts", "search", "Ada")
	run("create", "--json", "--account", "a@b.com", "contacts", "create", "--given", "Ada", "--email", "ada@example.com", "--phone", "+1")
	run("update", "--json", "--account", "a@b.com", "contacts", "update", "people/c1", "--given", "Ada", "--family", "Updated")
	run("delete", "--json", "--force", "--account", "a@b.com", "contacts", "delete", "people/c1")
	run("dir list", "--json", "--account", "a@b.com", "contacts", "directory", "list", "--max", "1")
	run("dir search", "--json", "--account", "a@b.com", "contacts", "directory", "search", "Dir", "--max", "1")
	run("other list", "--json", "--account", "a@b.com", "contacts", "other", "list", "--max", "1")
	run("other search", "--json", "--account", "a@b.com", "contacts", "other", "search", "Other")
}

func TestExecute_ContactsDirectoryOtherInvalidMaxFailsBeforeService(t *testing.T) {
	otherFactory := func(context.Context, string) (*people.Service, error) {
		t.Fatalf("expected max validation to fail before creating other contacts service")
		return nil, context.Canceled
	}
	directoryFactory := func(context.Context, string) (*people.Service, error) {
		t.Fatalf("expected max validation to fail before creating directory service")
		return nil, context.Canceled
	}

	testCases := [][]string{
		{"--account", "a@b.com", "contacts", "directory", "list", "--max", "0"},
		{"--account", "a@b.com", "contacts", "directory", "list", "--max=-1"},
		{"--account", "a@b.com", "contacts", "directory", "search", "alice", "--max", "0"},
		{"--account", "a@b.com", "contacts", "directory", "search", "alice", "--max=-1"},
		{"--account", "a@b.com", "contacts", "other", "list", "--max", "0"},
		{"--account", "a@b.com", "contacts", "other", "list", "--max=-1"},
		{"--account", "a@b.com", "contacts", "other", "search", "alice", "--max", "0"},
		{"--account", "a@b.com", "contacts", "other", "search", "alice", "--max=-1"},
	}
	for _, args := range testCases {
		t.Run(strings.Join(args[2:], "_"), func(t *testing.T) {
			err := executeWithPeopleTestServices(t, args, peopleTestServices{
				Directory: directoryFactory,
				Other:     otherFactory,
			}).err
			if err == nil || ExitCode(err) != 2 || !strings.Contains(err.Error(), "max must be > 0") {
				t.Fatalf("unexpected err: %v", err)
			}
		})
	}
}
