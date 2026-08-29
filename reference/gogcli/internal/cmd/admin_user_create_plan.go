package cmd

import (
	"strings"

	admin "google.golang.org/api/admin/directory/v1"
)

type adminUserCreateInput struct {
	Email         string
	GivenName     string
	FamilyName    string
	Password      string
	ChangePwd     bool
	OrgUnit       string
	Suspended     bool
	Archived      bool
	RecoveryEmail string
	RecoveryPhone string
	HashFunction  string
	Admin         bool
}

type adminUserCreatePlan struct {
	Email            string
	Password         string
	GeneratePassword bool
	User             *admin.User
	StatePatch       *admin.User
}

func newAdminUserCreatePlan(input adminUserCreateInput) (adminUserCreatePlan, error) {
	plan := adminUserCreatePlan{
		Email:    strings.TrimSpace(input.Email),
		Password: strings.TrimSpace(input.Password),
	}
	givenName := strings.TrimSpace(input.GivenName)
	familyName := strings.TrimSpace(input.FamilyName)
	if plan.Email == "" {
		return adminUserCreatePlan{}, usage("email required")
	}
	if err := validatePlainEmail("email", plan.Email); err != nil {
		return adminUserCreatePlan{}, err
	}
	if givenName == "" {
		return adminUserCreatePlan{}, usage("--given required")
	}
	if familyName == "" {
		return adminUserCreatePlan{}, usage("--family required")
	}
	if input.Admin {
		return adminUserCreatePlan{}, usage("--admin is not supported; assign admin roles separately after user creation")
	}

	hashFunction, err := normalizeAdminUserHashFunction(input.HashFunction)
	if err != nil {
		return adminUserCreatePlan{}, err
	}
	if hashFunction != "" && plan.Password == "" {
		return adminUserCreatePlan{}, usage("--password required when --hash-function is set")
	}

	plan.GeneratePassword = plan.Password == ""
	plan.User = &admin.User{
		PrimaryEmail: plan.Email,
		Name: &admin.UserName{
			GivenName:  givenName,
			FamilyName: familyName,
		},
		ChangePasswordAtNextLogin: input.ChangePwd || plan.GeneratePassword,
		Suspended:                 input.Suspended,
		Archived:                  input.Archived,
		OrgUnitPath:               strings.TrimSpace(input.OrgUnit),
		RecoveryEmail:             strings.TrimSpace(input.RecoveryEmail),
		RecoveryPhone:             strings.TrimSpace(input.RecoveryPhone),
		HashFunction:              hashFunction,
	}
	if plan.User.RecoveryEmail != "" {
		if err := validatePlainEmail("--recovery-email", plan.User.RecoveryEmail); err != nil {
			return adminUserCreatePlan{}, err
		}
	}
	if input.Suspended || input.Archived {
		plan.StatePatch = &admin.User{
			Suspended: input.Suspended,
			Archived:  input.Archived,
		}
	}
	return plan, nil
}

func (p adminUserCreatePlan) insertRequest(password string) *admin.User {
	user := *p.User
	user.Password = password
	return &user
}

func (p adminUserCreatePlan) dryRunPayload() map[string]any {
	passwordState := "provided"
	if p.GeneratePassword {
		passwordState = "generated"
	}
	return map[string]any{
		"user":     p.User,
		"password": passwordState,
	}
}
