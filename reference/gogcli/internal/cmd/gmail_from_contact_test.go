package cmd

import (
	"context"
	"strings"
	"testing"

	"google.golang.org/api/people/v1"
)

func TestBuildGmailFromEmailsQuery(t *testing.T) {
	if got := buildGmailFromEmailsQuery([]string{"a@example.com"}); got != "from:a@example.com" {
		t.Fatalf("single = %q", got)
	}
	if got := buildGmailFromEmailsQuery([]string{"a@example.com", "b@example.com"}); got != "from:(a@example.com OR b@example.com)" {
		t.Fatalf("multi = %q", got)
	}
}

func TestSelectGmailFromContactPeoplePrefersExactMatch(t *testing.T) {
	resp := &people.SearchResponse{Results: []*people.SearchResult{
		{Person: &people.Person{Names: []*people.Name{{DisplayName: "Alice A"}}, EmailAddresses: []*people.EmailAddress{{Value: "alice@example.com"}}}},
		{Person: &people.Person{Names: []*people.Name{{DisplayName: "Alice B"}}, EmailAddresses: []*people.EmailAddress{{Value: "b@example.com"}}}},
	}}
	got := selectGmailFromContactPeople("alice@example.com", resp)
	if len(got) != 1 || primaryName(got[0]) != "Alice A" {
		t.Fatalf("unexpected selection: %#v", got)
	}
}

func TestAllContactEmailsDedupes(t *testing.T) {
	got := allContactEmails(&people.Person{EmailAddresses: []*people.EmailAddress{
		{Value: "A@example.com"},
		{Value: "a@example.com"},
		{Value: "b@example.com"},
	}})
	if len(got) != 2 || got[0] != "A@example.com" || got[1] != "b@example.com" {
		t.Fatalf("emails = %#v", got)
	}
}

func TestGmailFromContactQuery_WarmsContactsSearchCache(t *testing.T) {
	var queries []string
	svc := newPeopleSearchTestService(t, "people:searchContacts", "people/c1", "Alice", "alice@example.com", &queries)

	got, err := gmailFromContactQuery(withPeopleContactsTestService(context.Background(), svc), "a@b.com", "Alice")
	if err != nil {
		t.Fatalf("gmailFromContactQuery: %v", err)
	}
	if got != "from:alice@example.com" {
		t.Fatalf("query = %q", got)
	}
	if got, want := strings.Join(queries, ","), ",Alice"; got != want {
		t.Fatalf("search queries = %q, want %q", got, want)
	}
}
