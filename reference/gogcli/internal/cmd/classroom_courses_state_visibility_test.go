package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"google.golang.org/api/classroom/v1"
)

func TestPollClassroomCourseStateEventuallyVisible(t *testing.T) {
	states := []string{classroomCourseStateActive, classroomCourseStateActive, classroomCourseStateArchived}
	fetchCalls := 0
	waitCalls := 0

	course, err := pollClassroomCourseState(
		context.Background(),
		"c1",
		classroomCourseStateArchived,
		[]time.Duration{0, time.Millisecond, time.Millisecond},
		func(context.Context, time.Duration) error {
			waitCalls++
			return nil
		},
		func(context.Context) (*classroom.Course, error) {
			state := states[fetchCalls]
			fetchCalls++
			return &classroom.Course{Id: "c1", CourseState: state}, nil
		},
	)
	if err != nil {
		t.Fatalf("poll state: %v", err)
	}
	if course.CourseState != classroomCourseStateArchived {
		t.Fatalf("state = %q, want %q", course.CourseState, classroomCourseStateArchived)
	}
	if fetchCalls != 3 || waitCalls != 2 {
		t.Fatalf("fetch calls = %d, wait calls = %d; want 3 and 2", fetchCalls, waitCalls)
	}
}

func TestPollClassroomCourseStateExhaustedIsRetryable(t *testing.T) {
	_, err := pollClassroomCourseState(
		context.Background(),
		"c1",
		classroomCourseStateArchived,
		[]time.Duration{0, time.Millisecond},
		func(context.Context, time.Duration) error { return nil },
		func(context.Context) (*classroom.Course, error) {
			return &classroom.Course{Id: "c1", CourseState: classroomCourseStateActive}, nil
		},
	)
	if err == nil {
		t.Fatal("expected error")
	}
	if ExitCode(err) != exitCodeRetryable {
		t.Fatalf("exit code = %d, want %d: %v", ExitCode(err), exitCodeRetryable, err)
	}
	if !strings.Contains(err.Error(), "reads still show state ACTIVE instead of ARCHIVED") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPollClassroomCourseStateCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	fetchCalled := false

	_, err := pollClassroomCourseState(
		ctx,
		"c1",
		classroomCourseStateArchived,
		[]time.Duration{0},
		func(context.Context, time.Duration) error { return nil },
		func(context.Context) (*classroom.Course, error) {
			fetchCalled = true
			return &classroom.Course{}, nil
		},
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context canceled", err)
	}
	if fetchCalled {
		t.Fatal("fetch called after cancellation")
	}
}

func TestPollClassroomCourseStateFetchError(t *testing.T) {
	apiErr := errors.New("get course failed")
	_, err := pollClassroomCourseState(
		context.Background(),
		"c1",
		classroomCourseStateArchived,
		[]time.Duration{0},
		func(context.Context, time.Duration) error { return nil },
		func(context.Context) (*classroom.Course, error) {
			return nil, apiErr
		},
	)
	if !errors.Is(err, apiErr) {
		t.Fatalf("error = %v, want wrapped fetch error", err)
	}
}

func TestClassroomCoursesArchiveReturnsVisibleCourse(t *testing.T) {
	patchCalls := 0
	getCalls := 0
	svc, closeService := newClassroomTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodPatch:
			patchCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "c1",
				"courseState": classroomCourseStateArchived,
			})
		case http.MethodGet:
			getCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "c1",
				"name":        "Visible Course",
				"courseState": classroomCourseStateArchived,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer closeService()

	result := executeWithClassroomTestService(t, []string{
		"--json",
		"--account", "a@b.com",
		"classroom", "courses", "archive", "c1",
	}, svc)
	if result.err != nil {
		t.Fatalf("archive course: %v", result.err)
	}
	if patchCalls != 1 || getCalls != 1 {
		t.Fatalf("patch calls = %d, get calls = %d; want 1 and 1", patchCalls, getCalls)
	}

	var payload struct {
		Course classroom.Course `json:"course"`
	}
	if err := json.Unmarshal([]byte(result.stdout), &payload); err != nil {
		t.Fatalf("decode output: %v", err)
	}
	if payload.Course.Name != "Visible Course" || payload.Course.CourseState != classroomCourseStateArchived {
		t.Fatalf("unexpected visible course: %#v", payload.Course)
	}
}
