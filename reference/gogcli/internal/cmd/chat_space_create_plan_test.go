package cmd

import (
	"strings"
	"testing"
)

func TestNewChatSpaceCreatePlan(t *testing.T) {
	plan, err := newChatSpaceCreatePlan(chatSpaceCreateInput{
		DisplayName: "  Engineering  ",
		Members:     []string{"a@example.com, users/b@example.com", "c@example.com"},
	})
	if err != nil {
		t.Fatalf("newChatSpaceCreatePlan: %v", err)
	}
	if plan.DisplayName != "Engineering" {
		t.Fatalf("DisplayName = %q", plan.DisplayName)
	}
	wantMembers := []string{"a@example.com", "users/b@example.com", "c@example.com"}
	if strings.Join(plan.Members, ",") != strings.Join(wantMembers, ",") {
		t.Fatalf("Members = %#v, want %#v", plan.Members, wantMembers)
	}
	wantUsers := []string{"users/a@example.com", "users/b@example.com", "users/c@example.com"}
	if strings.Join(plan.MemberUsers, ",") != strings.Join(wantUsers, ",") {
		t.Fatalf("MemberUsers = %#v, want %#v", plan.MemberUsers, wantUsers)
	}
	if plan.Request.Space == nil || plan.Request.Space.SpaceType != "SPACE" || plan.Request.Space.DisplayName != "Engineering" {
		t.Fatalf("unexpected space request: %#v", plan.Request.Space)
	}
	if len(plan.Request.Memberships) != 3 {
		t.Fatalf("membership count = %d", len(plan.Request.Memberships))
	}
	for i, membership := range plan.Request.Memberships {
		if membership.Member == nil || membership.Member.Name != wantUsers[i] || membership.Member.Type != "HUMAN" {
			t.Fatalf("membership %d = %#v", i, membership)
		}
	}

	payload := plan.dryRunPayload()
	if payload["display_name"] != "Engineering" {
		t.Fatalf("unexpected dry-run payload: %#v", payload)
	}
}

func TestNewChatSpaceCreatePlanWithoutMembers(t *testing.T) {
	plan, err := newChatSpaceCreatePlan(chatSpaceCreateInput{DisplayName: "Engineering"})
	if err != nil {
		t.Fatalf("newChatSpaceCreatePlan: %v", err)
	}
	if plan.Request.Memberships != nil {
		t.Fatalf("Memberships = %#v, want nil", plan.Request.Memberships)
	}
}

func TestNewChatSpaceCreatePlanValidation(t *testing.T) {
	tests := []struct {
		name  string
		input chatSpaceCreateInput
		want  string
	}{
		{name: "display name", input: chatSpaceCreateInput{}, want: "required: displayName"},
		{name: "member", input: chatSpaceCreateInput{DisplayName: "Team", Members: []string{"nope"}}, want: "invalid --member"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := newChatSpaceCreatePlan(tt.input)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want containing %q", err, tt.want)
			}
		})
	}
}
