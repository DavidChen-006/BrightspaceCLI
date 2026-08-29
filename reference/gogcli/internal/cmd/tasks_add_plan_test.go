package cmd

import (
	"strings"
	"testing"
)

func TestNewTasksAddPlan(t *testing.T) {
	t.Parallel()

	plan, err := newTasksAddPlan(tasksAddInput{
		TasklistID: " list ",
		Title:      " Task ",
		Notes:      " Notes ",
		Due:        "2026-01-02",
		Parent:     " parent ",
		Previous:   " previous ",
	})
	if err != nil {
		t.Fatalf("newTasksAddPlan: %v", err)
	}
	if plan.TasklistID != strList || plan.Title != "Task" || plan.Notes != "Notes" {
		t.Fatalf("unexpected plan: %#v", plan)
	}
	if plan.Parent != "parent" || plan.Previous != "previous" {
		t.Fatalf("unexpected placement: %#v", plan)
	}
	if plan.Date.DueValue != "2026-01-02T00:00:00Z" || plan.repeating() {
		t.Fatalf("unexpected date/repeat plan: %#v", plan)
	}
}

func TestNewTasksAddPlanRepeatSchedule(t *testing.T) {
	t.Parallel()

	plan, err := newTasksAddPlan(tasksAddInput{
		TasklistID:  strList,
		Title:       "Task",
		Due:         "2026-01-01",
		RecurRRule:  "FREQ=DAILY;INTERVAL=2",
		RepeatCount: 3,
	})
	if err != nil {
		t.Fatalf("newTasksAddPlan: %v", err)
	}
	schedule, err := plan.repeatSchedule()
	if err != nil {
		t.Fatalf("repeatSchedule: %v", err)
	}
	if len(schedule) != 3 {
		t.Fatalf("schedule length = %d", len(schedule))
	}
	got := []string{
		formatTaskDue(schedule[0], plan.Date.DueHasTime),
		formatTaskDue(schedule[1], plan.Date.DueHasTime),
		formatTaskDue(schedule[2], plan.Date.DueHasTime),
	}
	want := []string{
		"2026-01-01T00:00:00Z",
		"2026-01-03T00:00:00Z",
		"2026-01-05T00:00:00Z",
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("schedule[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestNewTasksAddPlanRepeatUntilAlignsDueTime(t *testing.T) {
	t.Parallel()

	plan, err := newTasksAddPlan(tasksAddInput{
		TasklistID:  strList,
		Title:       "Task",
		Due:         "2026-01-01T10:00:00Z",
		Repeat:      "daily",
		RepeatUntil: "2026-01-03",
	})
	if err != nil {
		t.Fatalf("newTasksAddPlan: %v", err)
	}
	schedule, err := plan.repeatSchedule()
	if err != nil {
		t.Fatalf("repeatSchedule: %v", err)
	}
	if len(schedule) != 3 || schedule[2].Format("2006-01-02T15:04:05Z07:00") != "2026-01-03T10:00:00Z" {
		t.Fatalf("unexpected schedule: %#v", schedule)
	}
}

func TestNewTasksAddPlanValidation(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name  string
		input tasksAddInput
		want  string
	}{
		{
			name:  "empty list",
			input: tasksAddInput{Title: "Task"},
			want:  "empty tasklistId",
		},
		{
			name:  "empty title",
			input: tasksAddInput{TasklistID: strList},
			want:  "required: --title",
		},
		{
			name:  "conflicting repeat",
			input: tasksAddInput{TasklistID: strList, Title: "Task", Due: "2026-01-01", Repeat: "daily", Recur: "daily"},
			want:  "--repeat cannot be combined",
		},
		{
			name:  "missing due",
			input: tasksAddInput{TasklistID: strList, Title: "Task", Repeat: "daily", RepeatCount: 2},
			want:  "--due is required",
		},
		{
			name:  "missing bound",
			input: tasksAddInput{TasklistID: strList, Title: "Task", Due: "2026-01-01", Repeat: "daily"},
			want:  "--repeat requires",
		},
		{
			name:  "invalid due",
			input: tasksAddInput{TasklistID: strList, Title: "Task", Due: "nope"},
			want:  "invalid date/time",
		},
		{
			name:  "empty schedule",
			input: tasksAddInput{TasklistID: strList, Title: "Task", Due: "2026-01-02", Repeat: "daily", RepeatUntil: "2026-01-01"},
			want:  "repeat produced no occurrences",
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := newTasksAddPlan(tc.input)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}
