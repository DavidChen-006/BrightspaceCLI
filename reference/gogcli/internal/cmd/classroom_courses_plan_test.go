package cmd

import (
	"strings"
	"testing"
)

func TestBuildClassroomCourseCreatePlan(t *testing.T) {
	plan, err := buildClassroomCourseCreatePlan(classroomCourseInput{
		Name:               " Biology ",
		OwnerID:            " teacher@example.com ",
		Section:            " Section A ",
		DescriptionHeading: " Science ",
		Description:        " Intro course ",
		Room:               " 101 ",
		State:              "active",
	})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	course := plan.Course
	if course.Name != "Biology" || course.OwnerId != "teacher@example.com" {
		t.Fatalf("unexpected required fields: %#v", course)
	}
	if course.Section != "Section A" || course.DescriptionHeading != "Science" ||
		course.Description != "Intro course" || course.Room != "101" ||
		course.CourseState != "ACTIVE" {
		t.Fatalf("unexpected optional fields: %#v", course)
	}
}

func TestBuildClassroomCourseUpdatePlan(t *testing.T) {
	plan, err := buildClassroomCourseUpdatePlan(classroomCourseUpdateInput{
		CourseID: " c1 ",
		classroomCourseInput: classroomCourseInput{
			Name:    " Biology 2 ",
			OwnerID: " owner@example.com ",
			Section: " Section B ",
			State:   "archived",
		},
	})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	if plan.CourseID != "c1" {
		t.Fatalf("course ID = %q", plan.CourseID)
	}
	if plan.UpdateMask != "name,ownerId,section,courseState" {
		t.Fatalf("update mask = %q", plan.UpdateMask)
	}
	if strings.Join(plan.UpdateFields, ",") != plan.UpdateMask {
		t.Fatalf("fields = %#v, mask = %q", plan.UpdateFields, plan.UpdateMask)
	}
	if plan.Course.Name != "Biology 2" || plan.Course.OwnerId != "owner@example.com" ||
		plan.Course.Section != "Section B" || plan.Course.CourseState != "ARCHIVED" {
		t.Fatalf("unexpected course: %#v", plan.Course)
	}
}

func TestBuildClassroomCoursePlanValidation(t *testing.T) {
	tests := []struct {
		name string
		run  func() error
		want string
	}{
		{
			name: "create name",
			run: func() error {
				_, err := buildClassroomCourseCreatePlan(classroomCourseInput{OwnerID: "me"})
				return err
			},
			want: "empty name",
		},
		{
			name: "create owner",
			run: func() error {
				_, err := buildClassroomCourseCreatePlan(classroomCourseInput{Name: "Biology"})
				return err
			},
			want: "empty owner",
		},
		{
			name: "update course ID",
			run: func() error {
				_, err := buildClassroomCourseUpdatePlan(classroomCourseUpdateInput{})
				return err
			},
			want: "empty courseId",
		},
		{
			name: "no updates",
			run: func() error {
				_, err := buildClassroomCourseUpdatePlan(classroomCourseUpdateInput{CourseID: "c1"})
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
