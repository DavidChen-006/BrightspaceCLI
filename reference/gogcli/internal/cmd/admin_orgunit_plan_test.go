package cmd

import (
	"strings"
	"testing"
)

func TestNewAdminOrgUnitCreatePlan(t *testing.T) {
	t.Parallel()

	plan, err := newAdminOrgUnitCreatePlan(adminOrgUnitCreateInput{
		Name:        " Engineering ",
		Parent:      " /Product ",
		Description: " Builders ",
	})
	if err != nil {
		t.Fatalf("newAdminOrgUnitCreatePlan: %v", err)
	}
	if plan.Request.Name != "Engineering" ||
		plan.Request.ParentOrgUnitPath != "/Product" ||
		plan.Request.Description != "Builders" {
		t.Fatalf("unexpected request: %#v", plan.Request)
	}

	defaultParent, err := newAdminOrgUnitCreatePlan(adminOrgUnitCreateInput{Name: "Engineering"})
	if err != nil {
		t.Fatalf("newAdminOrgUnitCreatePlan default parent: %v", err)
	}
	if defaultParent.Request.ParentOrgUnitPath != "/" {
		t.Fatalf("parent = %q, want /", defaultParent.Request.ParentOrgUnitPath)
	}
}

func TestNewAdminOrgUnitUpdatePlan(t *testing.T) {
	t.Parallel()

	name := " Eng "
	parent := " /Product "
	description := " "
	plan, err := newAdminOrgUnitUpdatePlan(adminOrgUnitUpdateInput{
		Path:        " /Engineering ",
		Name:        &name,
		Parent:      &parent,
		Description: &description,
	})
	if err != nil {
		t.Fatalf("newAdminOrgUnitUpdatePlan: %v", err)
	}
	if plan.Path != "Engineering" ||
		plan.Request.Name != "Eng" ||
		plan.Request.ParentOrgUnitPath != "/Product" ||
		plan.Request.Description != "" {
		t.Fatalf("unexpected plan: %#v", plan)
	}
	if len(plan.Request.ForceSendFields) != 1 || plan.Request.ForceSendFields[0] != "Description" {
		t.Fatalf("unexpected force-send fields: %#v", plan.Request.ForceSendFields)
	}
}

func TestNewAdminOrgUnitPlanValidation(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name    string
		run     func() error
		wantErr string
	}{
		{
			name: "create name",
			run: func() error {
				_, err := newAdminOrgUnitCreatePlan(adminOrgUnitCreateInput{})
				return err
			},
			wantErr: "org unit name required",
		},
		{
			name: "update path",
			run: func() error {
				name := "Engineering"
				_, err := newAdminOrgUnitUpdatePlan(adminOrgUnitUpdateInput{Name: &name})
				return err
			},
			wantErr: "org unit path required",
		},
		{
			name: "update fields",
			run: func() error {
				_, err := newAdminOrgUnitUpdatePlan(adminOrgUnitUpdateInput{Path: "/Engineering"})
				return err
			},
			wantErr: "no updates specified",
		},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			err := testCase.run()
			if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("error = %v, want %q", err, testCase.wantErr)
			}
		})
	}
}
