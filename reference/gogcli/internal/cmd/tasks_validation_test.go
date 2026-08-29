package cmd

import (
	"errors"
	"strings"
	"testing"
)

func TestExecute_TasksAdd_RequiresTitle(t *testing.T) {
	result := executeWithTasksTestServiceFactory(t,
		[]string{"--account", "a@b.com", "tasks", "add", "l1"},
		unexpectedTasksTestService(t, "expected validation to fail before creating service"),
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "required: --title") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_TasksListInvalidMaxFailsBeforeService(t *testing.T) {
	factory := unexpectedTasksTestService(t, "expected max validation to fail before creating service")
	cases := [][]string{
		{"--account", "a@b.com", "tasks", "lists", "--max", "0"},
		{"--account", "a@b.com", "tasks", "lists", "--max=-1"},
		{"--account", "a@b.com", "tasks", "list", "l1", "--max", "0"},
		{"--account", "a@b.com", "tasks", "list", "l1", "--max=-1"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			result := executeWithTasksTestServiceFactory(t, args, factory)
			if ExitCode(result.err) != 2 || !strings.Contains(result.err.Error(), "max must be > 0") {
				t.Fatalf("unexpected err: %v", result.err)
			}
		})
	}
}

func TestExecute_TasksAdd_RejectsInvalidDueBeforeDryRun(t *testing.T) {
	result := executeWithTasksTestServiceFactory(t,
		[]string{"--account", "a@b.com", "tasks", "add", "l1", "--title", "Task", "--due", "nope", "--dry-run"},
		unexpectedTasksTestService(t, "expected validation to fail before creating service"),
	)
	var exitErr *ExitError
	if !errors.As(result.err, &exitErr) || exitErr.Code != 2 || !strings.Contains(result.err.Error(), "invalid date/time") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_TasksAdd_RejectsInvalidRepeatDatesBeforeDryRun(t *testing.T) {
	factory := unexpectedTasksTestService(t, "expected validation to fail before creating service")
	for _, tc := range []struct {
		args    []string
		message string
	}{
		{
			args:    []string{"--account", "a@b.com", "tasks", "add", "l1", "--title", "Task", "--due", "2026-01-01", "--repeat", "daily", "--repeat-until", "nope", "--dry-run"},
			message: "invalid date/time",
		},
		{
			args:    []string{"--account", "a@b.com", "tasks", "add", "l1", "--title", "Task", "--due", "2026-01-02", "--repeat", "daily", "--repeat-until", "2026-01-01", "--dry-run"},
			message: "repeat produced no occurrences",
		},
	} {
		result := executeWithTasksTestServiceFactory(t, tc.args, factory)
		var exitErr *ExitError
		if !errors.As(result.err, &exitErr) || exitErr.Code != 2 || !strings.Contains(result.err.Error(), tc.message) {
			t.Fatalf("unexpected err: %v", result.err)
		}
	}
}

func TestExecute_TasksAdd_DryRunDoesNotExpandRepeatSchedule(t *testing.T) {
	result := executeWithTasksTestServiceFactory(t,
		[]string{"--account", "a@b.com", "tasks", "add", "l1", "--title", "Task", "--due", "2026-01-01", "--repeat", "daily", "--repeat-count", "1000000000", "--dry-run", "--json"},
		unexpectedTasksTestService(t, "dry-run should exit before creating service"),
	)
	if result.err != nil {
		t.Fatalf("unexpected err: %v", result.err)
	}
	if !strings.Contains(result.stdout, `"repeat_count": 1000000000`) {
		t.Fatalf("expected dry-run payload, got %s", result.stdout)
	}
}

func TestExecute_TasksUpdate_RequiresFields(t *testing.T) {
	result := executeWithTasksTestServiceFactory(t,
		[]string{"--account", "a@b.com", "tasks", "update", "l1", "t1"},
		unexpectedTasksTestService(t, "expected validation to fail before creating service"),
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "no fields to update") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_TasksUpdate_RejectsInvalidStatus(t *testing.T) {
	result := executeWithTasksTestServiceFactory(t,
		[]string{"--account", "a@b.com", "tasks", "update", "l1", "t1", "--status", "nope"},
		unexpectedTasksTestService(t, "expected validation to fail before creating service"),
	)
	if result.err == nil || !strings.Contains(result.err.Error(), "invalid --status") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}

func TestExecute_TasksUpdate_RejectsInvalidDueAsUsage(t *testing.T) {
	result := executeWithTasksTestServiceFactory(t,
		[]string{"--account", "a@b.com", "tasks", "update", "l1", "t1", "--due", "nope", "--dry-run"},
		unexpectedTasksTestService(t, "expected validation to fail before creating service"),
	)
	var exitErr *ExitError
	if !errors.As(result.err, &exitErr) || exitErr.Code != 2 || !strings.Contains(result.err.Error(), "invalid date/time") {
		t.Fatalf("unexpected err: %v", result.err)
	}
}
