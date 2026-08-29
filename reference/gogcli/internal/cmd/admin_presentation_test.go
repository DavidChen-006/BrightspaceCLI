package cmd

import (
	"strings"
	"testing"

	admin "google.golang.org/api/admin/directory/v1"
)

func TestAdminPresentationSchemas(t *testing.T) {
	t.Parallel()

	t.Run("users", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, nonNilAdminRows([]*admin.User{
			nil,
			{
				PrimaryEmail: "ada@example.com",
				Name:         &admin.UserName{FullName: "Ada\tLovelace"},
				IsAdmin:      true,
			},
		}), adminUserColumns())
		assertTableOutput(t, got, "EMAIL\tNAME\tSUSPENDED\tADMIN\nada@example.com\tAda Lovelace\tno\tyes\n")
	})

	t.Run("groups", func(t *testing.T) {
		t.Parallel()
		description := strings.Repeat("x", 51)
		got := renderPlainTable(t, []*admin.Group{{
			Email:              "engineering@example.com",
			Name:               "Engineering",
			DirectMembersCount: 12,
			Description:        description,
		}}, adminGroupColumns())
		assertTableOutput(
			t,
			got,
			"EMAIL\tNAME\tMEMBERS\tDESCRIPTION\n"+
				"engineering@example.com\tEngineering\t12\t"+strings.Repeat("x", 47)+"...\n",
		)
	})

	t.Run("members", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*admin.Member{{
			Email: "ada@example.com",
			Role:  "OWNER",
			Type:  "USER\tACCOUNT",
		}}, adminMemberColumns())
		assertTableOutput(t, got, "EMAIL\tROLE\tTYPE\nada@example.com\tOWNER\tUSER ACCOUNT\n")
	})

	t.Run("organizational units", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*admin.OrgUnit{{
			OrgUnitPath:       "/Engineering",
			Name:              "Engineering",
			OrgUnitId:         "ou-123",
			ParentOrgUnitPath: "/",
			Description:       "Build\tthings",
		}}, adminOrgUnitColumns())
		assertTableOutput(
			t,
			got,
			"PATH\tNAME\tID\tPARENT\tDESCRIPTION\n/Engineering\tEngineering\tou-123\t/\tBuild things\n",
		)
	})
}
