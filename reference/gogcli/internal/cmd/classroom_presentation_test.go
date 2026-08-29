package cmd

import (
	"strings"
	"testing"

	"google.golang.org/api/classroom/v1"
)

func TestClassroomPresentationSchemas(t *testing.T) {
	t.Parallel()

	profile := func(email, name string) *classroom.UserProfile {
		return &classroom.UserProfile{
			EmailAddress: email,
			Name:         &classroom.Name{FullName: name},
		}
	}

	t.Run("courses", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.Course{{
			Id:          "c1",
			Name:        "Biology\t101",
			Section:     "A",
			CourseState: "ACTIVE",
			OwnerId:     "teacher@example.com",
		}}, classroomCourseColumns())
		assertTableOutput(
			t,
			got,
			"ID\tNAME\tSECTION\tSTATE\tOWNER\nc1\tBiology 101\tA\tACTIVE\tteacher@example.com\n",
		)
	})

	t.Run("students", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.Student{{
			UserId:  "s1",
			Profile: profile("student@example.com", "Student One"),
		}}, classroomStudentColumns())
		assertTableOutput(t, got, "USER_ID\tEMAIL\tNAME\ns1\tstudent@example.com\tStudent One\n")
	})

	t.Run("teachers", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.Teacher{{
			UserId:  "t1",
			Profile: profile("teacher@example.com", "Teacher One"),
		}}, classroomTeacherColumns())
		assertTableOutput(t, got, "USER_ID\tEMAIL\tNAME\nt1\tteacher@example.com\tTeacher One\n")
	})

	t.Run("roster", func(t *testing.T) {
		t.Parallel()
		rows := classroomRosterRows(
			[]*classroom.Teacher{nil, {
				UserId:  "t1",
				Profile: profile("teacher@example.com", "Teacher One"),
			}},
			[]*classroom.Student{nil, {
				UserId:  "s1",
				Profile: profile("student@example.com", "Student One"),
			}},
		)
		got := renderPlainTable(t, rows, classroomRosterColumns())
		assertTableOutput(
			t,
			got,
			"ROLE\tUSER_ID\tEMAIL\tNAME\n"+
				"teacher\tt1\tteacher@example.com\tTeacher One\n"+
				"student\ts1\tstudent@example.com\tStudent One\n",
		)
	})

	t.Run("announcements", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.Announcement{{
			Id:            "a1",
			State:         "PUBLISHED",
			Text:          strings.Repeat("x", 51),
			ScheduledTime: "2026-06-13T12:00:00Z",
			UpdateTime:    "2026-06-12T12:00:00Z",
		}}, classroomAnnouncementColumns())
		assertTableOutput(
			t,
			got,
			"ID\tSTATE\tTEXT\tSCHEDULED\tUPDATED\n"+
				"a1\tPUBLISHED\t"+strings.Repeat("x", 50)+"...\t2026-06-13T12:00:00Z\t2026-06-12T12:00:00Z\n",
		)
	})

	t.Run("topics", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.Topic{{
			TopicId:    "topic1",
			Name:       "Week\tOne",
			UpdateTime: "2026-06-12T12:00:00Z",
		}}, classroomTopicColumns())
		assertTableOutput(t, got, "TOPIC_ID\tNAME\tUPDATED\ntopic1\tWeek One\t2026-06-12T12:00:00Z\n")
	})

	t.Run("coursework", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.CourseWork{{
			Id:        "cw1",
			Title:     "Homework",
			State:     "PUBLISHED",
			DueDate:   &classroom.Date{Year: 2026, Month: 6, Day: 20},
			DueTime:   &classroom.TimeOfDay{Hours: 14, Minutes: 30},
			WorkType:  "ASSIGNMENT",
			MaxPoints: 10.5,
		}}, classroomCourseworkColumns())
		assertTableOutput(
			t,
			got,
			"ID\tTITLE\tSTATE\tDUE\tTYPE\tMAX_POINTS\n"+
				"cw1\tHomework\tPUBLISHED\t2026-06-20 14:30\tASSIGNMENT\t10.5\n",
		)
	})

	t.Run("materials", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.CourseWorkMaterial{{
			Id:         "m1",
			Title:      "Reading",
			State:      "PUBLISHED",
			UpdateTime: "2026-06-12T12:00:00Z",
		}}, classroomMaterialColumns())
		assertTableOutput(t, got, "ID\tTITLE\tSTATE\tUPDATED\nm1\tReading\tPUBLISHED\t2026-06-12T12:00:00Z\n")
	})

	t.Run("invitations", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.Invitation{{
			Id:       "i1",
			CourseId: "c1",
			UserId:   "u1",
			Role:     "STUDENT",
		}}, classroomInvitationColumns())
		assertTableOutput(t, got, "ID\tCOURSE_ID\tUSER_ID\tROLE\ni1\tc1\tu1\tSTUDENT\n")
	})

	t.Run("submissions", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.StudentSubmission{{
			Id:            "sub1",
			UserId:        "u1",
			State:         "TURNED_IN",
			Late:          true,
			DraftGrade:    8,
			AssignedGrade: 9.5,
			UpdateTime:    "2026-06-12T12:00:00Z",
		}}, classroomSubmissionColumns())
		assertTableOutput(
			t,
			got,
			"ID\tUSER_ID\tSTATE\tLATE\tDRAFT\tASSIGNED\tUPDATED\n"+
				"sub1\tu1\tTURNED_IN\ttrue\t8\t9.5\t2026-06-12T12:00:00Z\n",
		)
	})

	t.Run("guardians", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.Guardian{{
			GuardianId:      "g1",
			GuardianProfile: profile("guardian@example.com", "Guardian One"),
		}}, classroomGuardianColumns())
		assertTableOutput(t, got, "GUARDIAN_ID\tEMAIL\tNAME\ng1\tguardian@example.com\tGuardian One\n")
	})

	t.Run("guardian invitations", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*classroom.GuardianInvitation{{
			InvitationId:        "gi1",
			InvitedEmailAddress: "guardian@example.com",
			State:               "PENDING",
			CreationTime:        "2026-06-12T12:00:00Z",
		}}, classroomGuardianInvitationColumns())
		assertTableOutput(
			t,
			got,
			"INVITATION_ID\tEMAIL\tSTATE\tCREATED\n"+
				"gi1\tguardian@example.com\tPENDING\t2026-06-12T12:00:00Z\n",
		)
	})
}

func TestCompactClassroomRows(t *testing.T) {
	t.Parallel()

	course := &classroom.Course{Id: "c1"}
	rows := compactClassroomRows([]*classroom.Course{nil, course, nil})
	if len(rows) != 1 || rows[0] != course {
		t.Fatalf("rows = %#v, want only c1", rows)
	}
}
