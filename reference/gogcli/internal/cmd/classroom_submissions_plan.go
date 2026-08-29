package cmd

import (
	"strings"

	"google.golang.org/api/classroom/v1"
)

type classroomSubmissionGradeInput struct {
	CourseID     string
	CourseworkID string
	SubmissionID string
	Draft        string
	Assigned     string
}

type classroomSubmissionGradePlan struct {
	CourseID     string
	CourseworkID string
	SubmissionID string
	Submission   *classroom.StudentSubmission
	UpdateFields []string
	UpdateMask   string
}

func buildClassroomSubmissionGradePlan(input classroomSubmissionGradeInput) (classroomSubmissionGradePlan, error) {
	courseID := strings.TrimSpace(input.CourseID)
	if courseID == "" {
		return classroomSubmissionGradePlan{}, usage("empty courseId")
	}
	courseworkID := strings.TrimSpace(input.CourseworkID)
	if courseworkID == "" {
		return classroomSubmissionGradePlan{}, usage("empty courseworkId")
	}
	submissionID := strings.TrimSpace(input.SubmissionID)
	if submissionID == "" {
		return classroomSubmissionGradePlan{}, usage("empty submissionId")
	}

	submission := &classroom.StudentSubmission{}
	fields := make([]string, 0, 2)
	if strings.TrimSpace(input.Draft) != "" {
		grade, err := parseFloat(input.Draft)
		if err != nil {
			return classroomSubmissionGradePlan{}, usage(err.Error())
		}
		submission.DraftGrade = grade
		fields = append(fields, "draftGrade")
	}
	if strings.TrimSpace(input.Assigned) != "" {
		grade, err := parseFloat(input.Assigned)
		if err != nil {
			return classroomSubmissionGradePlan{}, usage(err.Error())
		}
		submission.AssignedGrade = grade
		fields = append(fields, "assignedGrade")
	}
	if len(fields) == 0 {
		return classroomSubmissionGradePlan{}, usage("no grades specified")
	}

	return classroomSubmissionGradePlan{
		CourseID:     courseID,
		CourseworkID: courseworkID,
		SubmissionID: submissionID,
		Submission:   submission,
		UpdateFields: fields,
		UpdateMask:   updateMask(fields),
	}, nil
}
