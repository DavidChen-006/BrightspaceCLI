package cmd

import (
	"strings"

	"google.golang.org/api/classroom/v1"
)

type classroomCourseworkInput struct {
	CourseID    string
	Title       string
	Description string
	State       string
	MaxPoints   float64
	Due         string
	DueDate     string
	DueTime     string
	Scheduled   string
	TopicID     string
}

type classroomCourseworkCreateInput struct {
	classroomCourseworkInput
	WorkType string
}

type classroomCourseworkCreatePlan struct {
	CourseID   string
	Coursework *classroom.CourseWork
}

func buildClassroomCourseworkCreatePlan(input classroomCourseworkCreateInput) (classroomCourseworkCreatePlan, error) {
	courseID := strings.TrimSpace(input.CourseID)
	if courseID == "" {
		return classroomCourseworkCreatePlan{}, usage("empty courseId")
	}
	title := strings.TrimSpace(input.Title)
	if title == "" {
		return classroomCourseworkCreatePlan{}, usage("empty title")
	}

	work := &classroom.CourseWork{
		Title:       title,
		Description: strings.TrimSpace(input.Description),
		WorkType:    strings.ToUpper(strings.TrimSpace(input.WorkType)),
	}
	applyClassroomCourseworkOptionalFields(work, input.classroomCourseworkInput)

	dueDate, dueTime, err := resolveClassroomCourseworkDue(input.Due, input.DueDate, input.DueTime)
	if err != nil {
		return classroomCourseworkCreatePlan{}, err
	}
	work.DueDate = dueDate
	work.DueTime = dueTime

	return classroomCourseworkCreatePlan{
		CourseID:   courseID,
		Coursework: work,
	}, nil
}

type classroomCourseworkUpdateInput struct {
	classroomCourseworkInput
	CourseworkID string
}

type classroomCourseworkUpdatePlan struct {
	CourseID     string
	CourseworkID string
	Coursework   *classroom.CourseWork
	UpdateFields []string
	UpdateMask   string
}

func buildClassroomCourseworkUpdatePlan(input classroomCourseworkUpdateInput) (classroomCourseworkUpdatePlan, error) {
	courseID := strings.TrimSpace(input.CourseID)
	if courseID == "" {
		return classroomCourseworkUpdatePlan{}, usage("empty courseId")
	}
	courseworkID := strings.TrimSpace(input.CourseworkID)
	if courseworkID == "" {
		return classroomCourseworkUpdatePlan{}, usage("empty courseworkId")
	}

	work := &classroom.CourseWork{}
	fields := make([]string, 0, 8)
	if v := strings.TrimSpace(input.Title); v != "" {
		work.Title = v
		fields = append(fields, "title")
	}
	if v := strings.TrimSpace(input.Description); v != "" {
		work.Description = v
		fields = append(fields, "description")
	}
	if v := strings.TrimSpace(input.State); v != "" {
		work.State = strings.ToUpper(v)
		fields = append(fields, "state")
	}
	if input.MaxPoints != 0 {
		work.MaxPoints = input.MaxPoints
		fields = append(fields, "maxPoints")
	}
	if v := strings.TrimSpace(input.TopicID); v != "" {
		work.TopicId = v
		fields = append(fields, "topicId")
	}
	if v := strings.TrimSpace(input.Scheduled); v != "" {
		work.ScheduledTime = v
		fields = append(fields, "scheduledTime")
	}

	dueDate, dueTime, err := resolveClassroomCourseworkDue(input.Due, input.DueDate, input.DueTime)
	if err != nil {
		return classroomCourseworkUpdatePlan{}, err
	}
	if dueDate != nil {
		work.DueDate = dueDate
		fields = append(fields, "dueDate")
	}
	if dueTime != nil {
		work.DueTime = dueTime
		fields = append(fields, "dueTime")
	}
	if len(fields) == 0 {
		return classroomCourseworkUpdatePlan{}, usage("no updates specified")
	}

	return classroomCourseworkUpdatePlan{
		CourseID:     courseID,
		CourseworkID: courseworkID,
		Coursework:   work,
		UpdateFields: fields,
		UpdateMask:   updateMask(fields),
	}, nil
}

func applyClassroomCourseworkOptionalFields(work *classroom.CourseWork, input classroomCourseworkInput) {
	if v := strings.TrimSpace(input.State); v != "" {
		work.State = strings.ToUpper(v)
	}
	if input.MaxPoints != 0 {
		work.MaxPoints = input.MaxPoints
	}
	if v := strings.TrimSpace(input.TopicID); v != "" {
		work.TopicId = v
	}
	if v := strings.TrimSpace(input.Scheduled); v != "" {
		work.ScheduledTime = v
	}
}

func resolveClassroomCourseworkDue(due, dueDate, dueTime string) (*classroom.Date, *classroom.TimeOfDay, error) {
	var (
		date *classroom.Date
		time *classroom.TimeOfDay
		err  error
	)
	if strings.TrimSpace(due) != "" {
		date, time, err = parseClassroomDue(due)
	} else {
		if strings.TrimSpace(dueDate) != "" {
			date, err = parseClassroomDate(dueDate)
		}
		if err == nil && strings.TrimSpace(dueTime) != "" {
			time, err = parseClassroomTime(dueTime)
		}
	}
	if err != nil {
		return nil, nil, usage(err.Error())
	}
	if time != nil && date == nil {
		return nil, nil, usage("due time requires a due date")
	}
	return date, time, nil
}
