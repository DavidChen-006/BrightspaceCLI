package cmd

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNewFormsUpdatePlan(t *testing.T) {
	t.Parallel()

	plan, err := newFormsUpdatePlan(formsUpdateInput{
		FormID:      " https://docs.google.com/forms/d/form1/edit ",
		Title:       " Survey ",
		Description: " Details ",
		Quiz:        " TRUE ",
	})
	if err != nil {
		t.Fatalf("newFormsUpdatePlan: %v", err)
	}
	if plan.FormID != "form1" || plan.Title != "Survey" || plan.Description != "Details" || plan.Quiz != "true" {
		t.Fatalf("unexpected plan: %#v", plan)
	}
	if len(plan.Request.Requests) != 2 {
		t.Fatalf("request count = %d", len(plan.Request.Requests))
	}
	info := plan.Request.Requests[0].UpdateFormInfo
	if info == nil || info.UpdateMask != "title,description" || info.Info.Title != "Survey" || info.Info.Description != "Details" {
		t.Fatalf("unexpected info update: %#v", info)
	}
	settings := plan.Request.Requests[1].UpdateSettings
	if settings == nil || settings.UpdateMask != "quizSettings.isQuiz" || !settings.Settings.QuizSettings.IsQuiz {
		t.Fatalf("unexpected settings update: %#v", settings)
	}
	if !plan.Request.IncludeFormInResponse {
		t.Fatal("IncludeFormInResponse = false")
	}
}

func TestNewFormsUpdatePlanSendsFalseQuizValue(t *testing.T) {
	t.Parallel()

	plan, err := newFormsUpdatePlan(formsUpdateInput{
		FormID: "form1",
		Quiz:   "false",
	})
	if err != nil {
		t.Fatalf("newFormsUpdatePlan: %v", err)
	}
	payload, err := json.Marshal(plan.Request)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if !strings.Contains(string(payload), `"isQuiz":false`) {
		t.Fatalf("false quiz value omitted: %s", payload)
	}
}

func TestNewFormsUpdatePlanValidation(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name  string
		input formsUpdateInput
		want  string
	}{
		{
			name:  "empty form",
			input: formsUpdateInput{Title: "Survey"},
			want:  "empty formId",
		},
		{
			name:  "no fields",
			input: formsUpdateInput{FormID: "form1"},
			want:  "at least one",
		},
		{
			name:  "invalid quiz",
			input: formsUpdateInput{FormID: "form1", Quiz: "maybe"},
			want:  "--quiz must be true or false",
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := newFormsUpdatePlan(tc.input)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}
