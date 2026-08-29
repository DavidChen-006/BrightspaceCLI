package cmd

import (
	"strings"

	"google.golang.org/api/classroom/v1"
)

type classroomMaterialInput struct {
	CourseID    string
	Title       string
	Description string
	State       string
	Scheduled   string
	TopicID     string
}

type classroomMaterialCreatePlan struct {
	CourseID string
	Material *classroom.CourseWorkMaterial
}

func buildClassroomMaterialCreatePlan(input classroomMaterialInput) (classroomMaterialCreatePlan, error) {
	courseID := strings.TrimSpace(input.CourseID)
	if courseID == "" {
		return classroomMaterialCreatePlan{}, usage("empty courseId")
	}
	title := strings.TrimSpace(input.Title)
	if title == "" {
		return classroomMaterialCreatePlan{}, usage("empty title")
	}

	material := &classroom.CourseWorkMaterial{Title: title}
	applyClassroomMaterialOptionalFields(material, input)
	return classroomMaterialCreatePlan{
		CourseID: courseID,
		Material: material,
	}, nil
}

type classroomMaterialUpdateInput struct {
	classroomMaterialInput
	MaterialID string
}

type classroomMaterialUpdatePlan struct {
	CourseID     string
	MaterialID   string
	Material     *classroom.CourseWorkMaterial
	UpdateFields []string
	UpdateMask   string
}

func buildClassroomMaterialUpdatePlan(input classroomMaterialUpdateInput) (classroomMaterialUpdatePlan, error) {
	courseID := strings.TrimSpace(input.CourseID)
	if courseID == "" {
		return classroomMaterialUpdatePlan{}, usage("empty courseId")
	}
	materialID := strings.TrimSpace(input.MaterialID)
	if materialID == "" {
		return classroomMaterialUpdatePlan{}, usage("empty materialId")
	}

	material := &classroom.CourseWorkMaterial{}
	fields := make([]string, 0, 5)
	if v := strings.TrimSpace(input.Title); v != "" {
		material.Title = v
		fields = append(fields, "title")
	}
	if v := strings.TrimSpace(input.Description); v != "" {
		material.Description = v
		fields = append(fields, "description")
	}
	if v := strings.TrimSpace(input.State); v != "" {
		material.State = strings.ToUpper(v)
		fields = append(fields, "state")
	}
	if v := strings.TrimSpace(input.Scheduled); v != "" {
		material.ScheduledTime = v
		fields = append(fields, "scheduledTime")
	}
	if v := strings.TrimSpace(input.TopicID); v != "" {
		material.TopicId = v
		fields = append(fields, "topicId")
	}
	if len(fields) == 0 {
		return classroomMaterialUpdatePlan{}, usage("no updates specified")
	}

	return classroomMaterialUpdatePlan{
		CourseID:     courseID,
		MaterialID:   materialID,
		Material:     material,
		UpdateFields: fields,
		UpdateMask:   updateMask(fields),
	}, nil
}

func applyClassroomMaterialOptionalFields(material *classroom.CourseWorkMaterial, input classroomMaterialInput) {
	if v := strings.TrimSpace(input.Description); v != "" {
		material.Description = v
	}
	if v := strings.TrimSpace(input.State); v != "" {
		material.State = strings.ToUpper(v)
	}
	if v := strings.TrimSpace(input.Scheduled); v != "" {
		material.ScheduledTime = v
	}
	if v := strings.TrimSpace(input.TopicID); v != "" {
		material.TopicId = v
	}
}
