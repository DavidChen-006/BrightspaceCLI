package cmd

import (
	"strings"
	"testing"
)

func TestBuildClassroomCourseworkCreatePlan(t *testing.T) {
	plan, err := buildClassroomCourseworkCreatePlan(classroomCourseworkCreateInput{
		classroomCourseworkInput: classroomCourseworkInput{
			CourseID:    " c1 ",
			Title:       " Homework ",
			Description: " Read chapter 1 ",
			State:       "draft",
			MaxPoints:   10,
			Due:         "2024-03-15 14:30",
			DueDate:     "2025-01-01",
			DueTime:     "09:00",
			Scheduled:   "2024-03-10T12:00:00Z",
			TopicID:     " t1 ",
		},
		WorkType: "assignment",
	})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	if plan.CourseID != "c1" {
		t.Fatalf("course ID = %q", plan.CourseID)
	}
	work := plan.Coursework
	if work.Title != "Homework" || work.Description != "Read chapter 1" {
		t.Fatalf("unexpected text fields: %#v", work)
	}
	if work.WorkType != "ASSIGNMENT" || work.State != "DRAFT" {
		t.Fatalf("unexpected normalized enums: %#v", work)
	}
	if work.MaxPoints != 10 || work.TopicId != "t1" || work.ScheduledTime != "2024-03-10T12:00:00Z" {
		t.Fatalf("unexpected optional fields: %#v", work)
	}
	if got := formatClassroomDue(work.DueDate, work.DueTime); got != "2024-03-15 14:30" {
		t.Fatalf("due = %q", got)
	}
}

func TestBuildClassroomCourseworkUpdatePlan(t *testing.T) {
	plan, err := buildClassroomCourseworkUpdatePlan(classroomCourseworkUpdateInput{
		classroomCourseworkInput: classroomCourseworkInput{
			CourseID:  " c1 ",
			Title:     " Updated ",
			State:     "published",
			MaxPoints: 20,
			DueDate:   "2024-03-15",
			DueTime:   "14:30",
		},
		CourseworkID: " cw1 ",
	})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	if plan.CourseID != "c1" || plan.CourseworkID != "cw1" {
		t.Fatalf("unexpected identifiers: %#v", plan)
	}
	if plan.UpdateMask != "title,state,maxPoints,dueDate,dueTime" {
		t.Fatalf("update mask = %q", plan.UpdateMask)
	}
	if strings.Join(plan.UpdateFields, ",") != plan.UpdateMask {
		t.Fatalf("fields = %#v, mask = %q", plan.UpdateFields, plan.UpdateMask)
	}
	if got := formatClassroomDue(plan.Coursework.DueDate, plan.Coursework.DueTime); got != "2024-03-15 14:30" {
		t.Fatalf("due = %q", got)
	}
}

func TestBuildClassroomCourseworkPlanValidation(t *testing.T) {
	tests := []struct {
		name string
		run  func() error
		want string
	}{
		{
			name: "create title",
			run: func() error {
				_, err := buildClassroomCourseworkCreatePlan(classroomCourseworkCreateInput{
					classroomCourseworkInput: classroomCourseworkInput{CourseID: "c1"},
				})
				return err
			},
			want: "empty title",
		},
		{
			name: "due time without date",
			run: func() error {
				_, err := buildClassroomCourseworkCreatePlan(classroomCourseworkCreateInput{
					classroomCourseworkInput: classroomCourseworkInput{
						CourseID: "c1",
						Title:    "Work",
						DueTime:  "10:00",
					},
				})
				return err
			},
			want: "due time requires a due date",
		},
		{
			name: "update identifiers",
			run: func() error {
				_, err := buildClassroomCourseworkUpdatePlan(classroomCourseworkUpdateInput{
					classroomCourseworkInput: classroomCourseworkInput{CourseID: "c1"},
				})
				return err
			},
			want: "empty courseworkId",
		},
		{
			name: "no updates",
			run: func() error {
				_, err := buildClassroomCourseworkUpdatePlan(classroomCourseworkUpdateInput{
					classroomCourseworkInput: classroomCourseworkInput{CourseID: "c1"},
					CourseworkID:             "cw1",
				})
				return err
			},
			want: "no updates specified",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.run()
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
		})
	}
}
