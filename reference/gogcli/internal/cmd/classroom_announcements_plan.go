package cmd

import (
	"strings"

	"google.golang.org/api/classroom/v1"
)

type classroomAnnouncementInput struct {
	CourseID  string
	Text      string
	State     string
	Scheduled string
}

type classroomAnnouncementCreatePlan struct {
	CourseID     string
	Announcement *classroom.Announcement
}

func buildClassroomAnnouncementCreatePlan(input classroomAnnouncementInput) (classroomAnnouncementCreatePlan, error) {
	courseID := strings.TrimSpace(input.CourseID)
	if courseID == "" {
		return classroomAnnouncementCreatePlan{}, usage("empty courseId")
	}
	text := strings.TrimSpace(input.Text)
	if text == "" {
		return classroomAnnouncementCreatePlan{}, usage("empty text")
	}

	announcement := &classroom.Announcement{Text: text}
	applyClassroomAnnouncementOptionalFields(announcement, input)
	return classroomAnnouncementCreatePlan{
		CourseID:     courseID,
		Announcement: announcement,
	}, nil
}

type classroomAnnouncementUpdateInput struct {
	classroomAnnouncementInput
	AnnouncementID string
}

type classroomAnnouncementUpdatePlan struct {
	CourseID       string
	AnnouncementID string
	Announcement   *classroom.Announcement
	UpdateFields   []string
	UpdateMask     string
}

func buildClassroomAnnouncementUpdatePlan(input classroomAnnouncementUpdateInput) (classroomAnnouncementUpdatePlan, error) {
	courseID := strings.TrimSpace(input.CourseID)
	if courseID == "" {
		return classroomAnnouncementUpdatePlan{}, usage("empty courseId")
	}
	announcementID := strings.TrimSpace(input.AnnouncementID)
	if announcementID == "" {
		return classroomAnnouncementUpdatePlan{}, usage("empty announcementId")
	}

	announcement := &classroom.Announcement{}
	fields := make([]string, 0, 3)
	if v := strings.TrimSpace(input.Text); v != "" {
		announcement.Text = v
		fields = append(fields, "text")
	}
	if v := strings.TrimSpace(input.State); v != "" {
		announcement.State = strings.ToUpper(v)
		fields = append(fields, "state")
	}
	if v := strings.TrimSpace(input.Scheduled); v != "" {
		announcement.ScheduledTime = v
		fields = append(fields, "scheduledTime")
	}
	if len(fields) == 0 {
		return classroomAnnouncementUpdatePlan{}, usage("no updates specified")
	}

	return classroomAnnouncementUpdatePlan{
		CourseID:       courseID,
		AnnouncementID: announcementID,
		Announcement:   announcement,
		UpdateFields:   fields,
		UpdateMask:     updateMask(fields),
	}, nil
}

func applyClassroomAnnouncementOptionalFields(announcement *classroom.Announcement, input classroomAnnouncementInput) {
	if v := strings.TrimSpace(input.State); v != "" {
		announcement.State = strings.ToUpper(v)
	}
	if v := strings.TrimSpace(input.Scheduled); v != "" {
		announcement.ScheduledTime = v
	}
}
