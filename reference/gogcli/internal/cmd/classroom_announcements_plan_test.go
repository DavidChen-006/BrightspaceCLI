package cmd

import (
	"strings"
	"testing"
)

func TestBuildClassroomAnnouncementCreatePlan(t *testing.T) {
	plan, err := buildClassroomAnnouncementCreatePlan(classroomAnnouncementInput{
		CourseID:  " c1 ",
		Text:      " Hello class ",
		State:     "draft",
		Scheduled: "2024-03-10T12:00:00Z",
	})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	if plan.CourseID != "c1" {
		t.Fatalf("course ID = %q", plan.CourseID)
	}
	if plan.Announcement.Text != "Hello class" || plan.Announcement.State != "DRAFT" ||
		plan.Announcement.ScheduledTime != "2024-03-10T12:00:00Z" {
		t.Fatalf("unexpected announcement: %#v", plan.Announcement)
	}
}

func TestBuildClassroomAnnouncementUpdatePlan(t *testing.T) {
	plan, err := buildClassroomAnnouncementUpdatePlan(classroomAnnouncementUpdateInput{
		classroomAnnouncementInput: classroomAnnouncementInput{
			CourseID:  " c1 ",
			Text:      " Updated ",
			State:     "published",
			Scheduled: "2024-03-11T12:00:00Z",
		},
		AnnouncementID: " a1 ",
	})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	if plan.CourseID != "c1" || plan.AnnouncementID != "a1" {
		t.Fatalf("unexpected identifiers: %#v", plan)
	}
	if plan.UpdateMask != "text,state,scheduledTime" {
		t.Fatalf("update mask = %q", plan.UpdateMask)
	}
	if strings.Join(plan.UpdateFields, ",") != plan.UpdateMask {
		t.Fatalf("fields = %#v, mask = %q", plan.UpdateFields, plan.UpdateMask)
	}
	if plan.Announcement.Text != "Updated" || plan.Announcement.State != "PUBLISHED" {
		t.Fatalf("unexpected announcement: %#v", plan.Announcement)
	}
}

func TestBuildClassroomPlanValidation(t *testing.T) {
	tests := []struct {
		name string
		run  func() error
		want string
	}{
		{
			name: "announcement create course ID",
			run: func() error {
				_, err := buildClassroomAnnouncementCreatePlan(classroomAnnouncementInput{Text: "Hello"})
				return err
			},
			want: "empty courseId",
		},
		{
			name: "announcement create text",
			run: func() error {
				_, err := buildClassroomAnnouncementCreatePlan(classroomAnnouncementInput{CourseID: "c1"})
				return err
			},
			want: "empty text",
		},
		{
			name: "announcement update ID",
			run: func() error {
				_, err := buildClassroomAnnouncementUpdatePlan(classroomAnnouncementUpdateInput{
					classroomAnnouncementInput: classroomAnnouncementInput{CourseID: "c1"},
				})
				return err
			},
			want: "empty announcementId",
		},
		{
			name: "announcement no updates",
			run: func() error {
				_, err := buildClassroomAnnouncementUpdatePlan(classroomAnnouncementUpdateInput{
					classroomAnnouncementInput: classroomAnnouncementInput{CourseID: "c1"},
					AnnouncementID:             "a1",
				})
				return err
			},
			want: "no updates specified",
		},
		{
			name: "material create course ID",
			run: func() error {
				_, err := buildClassroomMaterialCreatePlan(classroomMaterialInput{Title: "Reading"})
				return err
			},
			want: "empty courseId",
		},
		{
			name: "material create title",
			run: func() error {
				_, err := buildClassroomMaterialCreatePlan(classroomMaterialInput{CourseID: "c1"})
				return err
			},
			want: "empty title",
		},
		{
			name: "material update ID",
			run: func() error {
				_, err := buildClassroomMaterialUpdatePlan(classroomMaterialUpdateInput{
					classroomMaterialInput: classroomMaterialInput{CourseID: "c1"},
				})
				return err
			},
			want: "empty materialId",
		},
		{
			name: "material no updates",
			run: func() error {
				_, err := buildClassroomMaterialUpdatePlan(classroomMaterialUpdateInput{
					classroomMaterialInput: classroomMaterialInput{CourseID: "c1"},
					MaterialID:             "m1",
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
