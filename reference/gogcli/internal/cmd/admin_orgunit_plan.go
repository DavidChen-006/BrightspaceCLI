package cmd

import (
	"strings"

	admin "google.golang.org/api/admin/directory/v1"
)

type adminOrgUnitCreateInput struct {
	Name        string
	Parent      string
	Description string
}

type adminOrgUnitCreatePlan struct {
	Request *admin.OrgUnit
}

func newAdminOrgUnitCreatePlan(input adminOrgUnitCreateInput) (adminOrgUnitCreatePlan, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return adminOrgUnitCreatePlan{}, usage("org unit name required")
	}
	parent := strings.TrimSpace(input.Parent)
	if parent == "" {
		parent = "/"
	}
	return adminOrgUnitCreatePlan{
		Request: &admin.OrgUnit{
			Name:              name,
			ParentOrgUnitPath: parent,
			Description:       strings.TrimSpace(input.Description),
		},
	}, nil
}

type adminOrgUnitUpdateInput struct {
	Path        string
	Name        *string
	Parent      *string
	Description *string
}

type adminOrgUnitUpdatePlan struct {
	Path    string
	Request *admin.OrgUnit
}

func newAdminOrgUnitUpdatePlan(input adminOrgUnitUpdateInput) (adminOrgUnitUpdatePlan, error) {
	rawPath := strings.TrimSpace(input.Path)
	if rawPath == "" {
		return adminOrgUnitUpdatePlan{}, usage("org unit path required")
	}

	request := &admin.OrgUnit{}
	hasUpdates := false
	if input.Name != nil {
		request.Name = strings.TrimSpace(*input.Name)
		hasUpdates = true
	}
	if input.Parent != nil {
		request.ParentOrgUnitPath = strings.TrimSpace(*input.Parent)
		hasUpdates = true
	}
	if input.Description != nil {
		request.Description = strings.TrimSpace(*input.Description)
		if request.Description == "" {
			request.ForceSendFields = append(request.ForceSendFields, "Description")
		}
		hasUpdates = true
	}
	if !hasUpdates {
		return adminOrgUnitUpdatePlan{}, usage("no updates specified")
	}

	return adminOrgUnitUpdatePlan{
		Path:    normalizeAdminOrgUnitPath(rawPath),
		Request: request,
	}, nil
}
