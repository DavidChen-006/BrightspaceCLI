package cmd

import (
	"strings"
	"testing"
)

func TestNewAdminUserCreatePlan(t *testing.T) {
	t.Parallel()

	plan, err := newAdminUserCreatePlan(adminUserCreateInput{
		Email:         " ada@example.com ",
		GivenName:     " Ada ",
		FamilyName:    " Lovelace ",
		Password:      " hashed-password ",
		ChangePwd:     true,
		OrgUnit:       " /Engineering ",
		Suspended:     true,
		Archived:      true,
		RecoveryEmail: " recovery@example.net ",
		RecoveryPhone: " +15551234567 ",
		HashFunction:  " sha1 ",
	})
	if err != nil {
		t.Fatalf("newAdminUserCreatePlan: %v", err)
	}
	if plan.Email != "ada@example.com" || plan.Password != "hashed-password" || plan.GeneratePassword {
		t.Fatalf("unexpected password plan: %#v", plan)
	}
	if plan.User.PrimaryEmail != "ada@example.com" ||
		plan.User.Name == nil ||
		plan.User.Name.GivenName != "Ada" ||
		plan.User.Name.FamilyName != "Lovelace" {
		t.Fatalf("unexpected identity: %#v", plan.User)
	}
	if plan.User.OrgUnitPath != "/Engineering" ||
		plan.User.RecoveryEmail != "recovery@example.net" ||
		plan.User.RecoveryPhone != "+15551234567" ||
		plan.User.HashFunction != "SHA-1" {
		t.Fatalf("unexpected profile: %#v", plan.User)
	}
	if !plan.User.ChangePasswordAtNextLogin || !plan.User.Suspended || !plan.User.Archived {
		t.Fatalf("unexpected state: %#v", plan.User)
	}
	if plan.StatePatch == nil || !plan.StatePatch.Suspended || !plan.StatePatch.Archived {
		t.Fatalf("unexpected state patch: %#v", plan.StatePatch)
	}
	request := plan.insertRequest(plan.Password)
	if request.Password != "hashed-password" || plan.User.Password != "" {
		t.Fatalf("unexpected insert request: %#v template=%#v", request, plan.User)
	}
}

func TestNewAdminUserCreatePlanGeneratesPassword(t *testing.T) {
	t.Parallel()

	plan, err := newAdminUserCreatePlan(adminUserCreateInput{
		Email:      "grace@example.com",
		GivenName:  "Grace",
		FamilyName: "Hopper",
	})
	if err != nil {
		t.Fatalf("newAdminUserCreatePlan: %v", err)
	}
	if !plan.GeneratePassword || !plan.User.ChangePasswordAtNextLogin {
		t.Fatalf("unexpected generated-password plan: %#v", plan)
	}
	if got := plan.dryRunPayload()["password"]; got != "generated" {
		t.Fatalf("dry-run password state = %#v, want generated", got)
	}
	if plan.StatePatch != nil {
		t.Fatalf("unexpected state patch: %#v", plan.StatePatch)
	}
}

func TestNewAdminUserCreatePlanValidation(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name    string
		input   adminUserCreateInput
		wantErr string
	}{
		{name: "missing email", input: adminUserCreateInput{GivenName: "Ada", FamilyName: "Lovelace", Password: "pw"}, wantErr: "email required"},
		{name: "invalid email", input: adminUserCreateInput{Email: "nope", GivenName: "Ada", FamilyName: "Lovelace", Password: "pw"}, wantErr: "invalid email"},
		{name: "missing given", input: adminUserCreateInput{Email: "ada@example.com", FamilyName: "Lovelace", Password: "pw"}, wantErr: "--given required"},
		{name: "missing family", input: adminUserCreateInput{Email: "ada@example.com", GivenName: "Ada", Password: "pw"}, wantErr: "--family required"},
		{name: "admin unsupported", input: adminUserCreateInput{Email: "ada@example.com", GivenName: "Ada", FamilyName: "Lovelace", Password: "pw", Admin: true}, wantErr: "--admin is not supported"},
		{name: "bad hash", input: adminUserCreateInput{Email: "ada@example.com", GivenName: "Ada", FamilyName: "Lovelace", Password: "pw", HashFunction: "bcrypt"}, wantErr: "invalid --hash-function"},
		{name: "hash without password", input: adminUserCreateInput{Email: "ada@example.com", GivenName: "Ada", FamilyName: "Lovelace", HashFunction: "sha1"}, wantErr: "--password required when --hash-function is set"},
		{name: "invalid recovery email", input: adminUserCreateInput{Email: "ada@example.com", GivenName: "Ada", FamilyName: "Lovelace", RecoveryEmail: "nope"}, wantErr: "invalid --recovery-email"},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			_, err := newAdminUserCreatePlan(testCase.input)
			if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("newAdminUserCreatePlan() error = %v, want %q", err, testCase.wantErr)
			}
		})
	}
}
