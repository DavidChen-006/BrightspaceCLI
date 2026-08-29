package cmd

import (
	"strings"
	"testing"
)

func TestBuildClassroomSubmissionGradePlan(t *testing.T) {
	plan, err := buildClassroomSubmissionGradePlan(classroomSubmissionGradeInput{
		CourseID:     " c1 ",
		CourseworkID: " cw1 ",
		SubmissionID: " s1 ",
		Draft:        " 5.5 ",
		Assigned:     "10",
	})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	if plan.CourseID != "c1" || plan.CourseworkID != "cw1" || plan.SubmissionID != "s1" {
		t.Fatalf("unexpected identifiers: %#v", plan)
	}
	if plan.UpdateMask != "draftGrade,assignedGrade" {
		t.Fatalf("update mask = %q", plan.UpdateMask)
	}
	if strings.Join(plan.UpdateFields, ",") != plan.UpdateMask {
		t.Fatalf("fields = %#v, mask = %q", plan.UpdateFields, plan.UpdateMask)
	}
	if plan.Submission.DraftGrade != 5.5 || plan.Submission.AssignedGrade != 10 {
		t.Fatalf("unexpected grades: %#v", plan.Submission)
	}
}

func TestBuildClassroomSubmissionGradePlanValidation(t *testing.T) {
	tests := []struct {
		name  string
		input classroomSubmissionGradeInput
		want  string
	}{
		{
			name: "course ID",
			input: classroomSubmissionGradeInput{
				CourseworkID: "cw1",
				SubmissionID: "s1",
				Draft:        "5",
			},
			want: "empty courseId",
		},
		{
			name: "coursework ID",
			input: classroomSubmissionGradeInput{
				CourseID:     "c1",
				SubmissionID: "s1",
				Draft:        "5",
			},
			want: "empty courseworkId",
		},
		{
			name: "submission ID",
			input: classroomSubmissionGradeInput{
				CourseID:     "c1",
				CourseworkID: "cw1",
				Draft:        "5",
			},
			want: "empty submissionId",
		},
		{
			name: "invalid grade",
			input: classroomSubmissionGradeInput{
				CourseID:     "c1",
				CourseworkID: "cw1",
				SubmissionID: "s1",
				Assigned:     "bad",
			},
			want: "invalid number",
		},
		{
			name: "no grades",
			input: classroomSubmissionGradeInput{
				CourseID:     "c1",
				CourseworkID: "cw1",
				SubmissionID: "s1",
			},
			want: "no grades specified",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := buildClassroomSubmissionGradePlan(tt.input)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
		})
	}
}
