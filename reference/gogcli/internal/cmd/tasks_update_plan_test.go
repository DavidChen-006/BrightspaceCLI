package cmd

import (
	"strings"
	"testing"
)

func TestNewTasksUpdatePlan(t *testing.T) {
	t.Parallel()

	plan, err := newTasksUpdatePlan(tasksUpdateInput{
		TasklistID: " list ",
		TaskID:     " task ",
		Title:      " title ",
		Notes:      " notes ",
		Due:        "2026-01-02",
		Status:     taskStatusCompleted,
	}, tasksUpdateFields{
		Title:  true,
		Notes:  true,
		Due:    true,
		Status: true,
	})
	if err != nil {
		t.Fatalf("newTasksUpdatePlan: %v", err)
	}
	if plan.TasklistID != strList || plan.TaskID != "task" {
		t.Fatalf("unexpected IDs: %#v", plan)
	}
	if plan.Patch.Title != "title" || plan.Patch.Notes != "notes" || plan.Patch.Status != taskStatusCompleted {
		t.Fatalf("unexpected patch: %#v", plan.Patch)
	}
	if plan.Patch.Due != "2026-01-02T00:00:00Z" || plan.WarnDue != "2026-01-02" {
		t.Fatalf("unexpected due plan: %#v", plan)
	}
}

func TestNewTasksUpdatePlanClearsDue(t *testing.T) {
	t.Parallel()

	plan, err := newTasksUpdatePlan(tasksUpdateInput{
		TasklistID: strList,
		TaskID:     "task",
	}, tasksUpdateFields{Due: true})
	if err != nil {
		t.Fatalf("newTasksUpdatePlan: %v", err)
	}
	if len(plan.Patch.NullFields) != 1 || plan.Patch.NullFields[0] != "Due" {
		t.Fatalf("unexpected null fields: %#v", plan.Patch.NullFields)
	}
	if plan.WarnDue != "" {
		t.Fatalf("WarnDue = %q", plan.WarnDue)
	}
}

func TestNewTasksUpdatePlanValidation(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		input  tasksUpdateInput
		fields tasksUpdateFields
		want   string
	}{
		{
			name:   "empty list",
			input:  tasksUpdateInput{TaskID: "task"},
			fields: tasksUpdateFields{Title: true},
			want:   "empty tasklistId",
		},
		{
			name:   "empty task",
			input:  tasksUpdateInput{TasklistID: strList},
			fields: tasksUpdateFields{Title: true},
			want:   "empty taskId",
		},
		{
			name:  "no fields",
			input: tasksUpdateInput{TasklistID: strList, TaskID: "task"},
			want:  "no fields to update",
		},
		{
			name:   "invalid due",
			input:  tasksUpdateInput{TasklistID: strList, TaskID: "task", Due: "nope"},
			fields: tasksUpdateFields{Due: true},
			want:   "invalid date/time",
		},
		{
			name:   "invalid status",
			input:  tasksUpdateInput{TasklistID: strList, TaskID: "task", Status: "nope"},
			fields: tasksUpdateFields{Status: true},
			want:   "invalid --status",
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := newTasksUpdatePlan(tc.input, tc.fields)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}
