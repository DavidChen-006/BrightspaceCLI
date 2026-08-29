package cmd

import (
	"strings"

	"google.golang.org/api/classroom/v1"
)

type classroomCourseInput struct {
	Name               string
	OwnerID            string
	Section            string
	DescriptionHeading string
	Description        string
	Room               string
	State              string
}

type classroomCourseCreatePlan struct {
	Course *classroom.Course
}

func buildClassroomCourseCreatePlan(input classroomCourseInput) (classroomCourseCreatePlan, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return classroomCourseCreatePlan{}, usage("empty name")
	}
	ownerID := strings.TrimSpace(input.OwnerID)
	if ownerID == "" {
		return classroomCourseCreatePlan{}, usage("empty owner")
	}

	course := &classroom.Course{
		Name:    name,
		OwnerId: ownerID,
	}
	applyClassroomCourseOptionalFields(course, input)
	return classroomCourseCreatePlan{Course: course}, nil
}

type classroomCourseUpdateInput struct {
	classroomCourseInput
	CourseID string
}

type classroomCourseUpdatePlan struct {
	CourseID     string
	Course       *classroom.Course
	UpdateFields []string
	UpdateMask   string
}

func buildClassroomCourseUpdatePlan(input classroomCourseUpdateInput) (classroomCourseUpdatePlan, error) {
	courseID := strings.TrimSpace(input.CourseID)
	if courseID == "" {
		return classroomCourseUpdatePlan{}, usage("empty courseId")
	}

	course := &classroom.Course{}
	fields := make([]string, 0, 7)
	if v := strings.TrimSpace(input.Name); v != "" {
		course.Name = v
		fields = append(fields, "name")
	}
	if v := strings.TrimSpace(input.OwnerID); v != "" {
		course.OwnerId = v
		fields = append(fields, "ownerId")
	}
	if v := strings.TrimSpace(input.Section); v != "" {
		course.Section = v
		fields = append(fields, "section")
	}
	if v := strings.TrimSpace(input.DescriptionHeading); v != "" {
		course.DescriptionHeading = v
		fields = append(fields, "descriptionHeading")
	}
	if v := strings.TrimSpace(input.Description); v != "" {
		course.Description = v
		fields = append(fields, "description")
	}
	if v := strings.TrimSpace(input.Room); v != "" {
		course.Room = v
		fields = append(fields, "room")
	}
	if v := strings.TrimSpace(input.State); v != "" {
		course.CourseState = strings.ToUpper(v)
		fields = append(fields, "courseState")
	}
	if len(fields) == 0 {
		return classroomCourseUpdatePlan{}, usage("no updates specified")
	}

	return classroomCourseUpdatePlan{
		CourseID:     courseID,
		Course:       course,
		UpdateFields: fields,
		UpdateMask:   updateMask(fields),
	}, nil
}

func applyClassroomCourseOptionalFields(course *classroom.Course, input classroomCourseInput) {
	if v := strings.TrimSpace(input.Section); v != "" {
		course.Section = v
	}
	if v := strings.TrimSpace(input.DescriptionHeading); v != "" {
		course.DescriptionHeading = v
	}
	if v := strings.TrimSpace(input.Description); v != "" {
		course.Description = v
	}
	if v := strings.TrimSpace(input.Room); v != "" {
		course.Room = v
	}
	if v := strings.TrimSpace(input.State); v != "" {
		course.CourseState = strings.ToUpper(v)
	}
}
