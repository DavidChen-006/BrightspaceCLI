package cmd

import (
	"strconv"
	"strings"

	formsapi "google.golang.org/api/forms/v1"
)

type formsUpdateInput struct {
	FormID      string
	Title       string
	Description string
	Quiz        string
}

type formsUpdatePlan struct {
	FormID      string
	Title       string
	Description string
	Quiz        string
	Request     *formsapi.BatchUpdateFormRequest
}

func newFormsUpdatePlan(input formsUpdateInput) (formsUpdatePlan, error) {
	plan := formsUpdatePlan{
		FormID:      strings.TrimSpace(normalizeGoogleID(input.FormID)),
		Title:       strings.TrimSpace(input.Title),
		Description: strings.TrimSpace(input.Description),
		Quiz:        strings.TrimSpace(strings.ToLower(input.Quiz)),
	}
	if plan.FormID == "" {
		return formsUpdatePlan{}, usage("empty formId")
	}
	if plan.Title == "" && plan.Description == "" && plan.Quiz == "" {
		return formsUpdatePlan{}, usage("at least one of --title, --description, or --quiz is required")
	}

	var requests []*formsapi.Request
	if plan.Title != "" || plan.Description != "" {
		info := &formsapi.Info{}
		var masks []string
		if plan.Title != "" {
			info.Title = plan.Title
			masks = append(masks, "title")
		}
		if plan.Description != "" {
			info.Description = plan.Description
			masks = append(masks, "description")
		}
		requests = append(requests, &formsapi.Request{
			UpdateFormInfo: &formsapi.UpdateFormInfoRequest{
				Info:       info,
				UpdateMask: strings.Join(masks, ","),
			},
		})
	}

	if plan.Quiz != "" {
		isQuiz, err := strconv.ParseBool(plan.Quiz)
		if err != nil {
			return formsUpdatePlan{}, usage("--quiz must be true or false")
		}
		requests = append(requests, &formsapi.Request{
			UpdateSettings: &formsapi.UpdateSettingsRequest{
				Settings: &formsapi.FormSettings{
					QuizSettings: &formsapi.QuizSettings{
						IsQuiz:          isQuiz,
						ForceSendFields: []string{"IsQuiz"},
					},
				},
				UpdateMask: "quizSettings.isQuiz",
			},
		})
	}

	plan.Request = &formsapi.BatchUpdateFormRequest{
		Requests:              requests,
		IncludeFormInResponse: true,
	}
	return plan, nil
}

func (p formsUpdatePlan) dryRunPayload() map[string]any {
	return map[string]any{
		"form_id":     p.FormID,
		"title":       p.Title,
		"description": p.Description,
		"quiz":        p.Quiz,
	}
}
