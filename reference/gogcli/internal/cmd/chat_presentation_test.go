package cmd

import (
	"testing"

	"google.golang.org/api/chat/v1"
)

func TestChatPresentationSchemas(t *testing.T) {
	t.Parallel()

	t.Run("spaces", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*chat.Space{{
			Name:        "spaces/aaa",
			DisplayName: "Engineering\tTeam",
			SpaceType:   "SPACE",
		}}, chatSpaceColumns())
		assertTableOutput(t, got, "RESOURCE\tNAME\tTYPE\nspaces/aaa\tEngineering Team\tSPACE\n")
	})

	t.Run("messages", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*chat.Message{{
			Name:       "spaces/aaa/messages/m1",
			Text:       "line one\nline\ttwo",
			CreateTime: "2026-06-12T12:00:00Z",
			Sender:     &chat.User{DisplayName: "Ada\tLovelace"},
		}}, chatMessageColumns())
		assertTableOutput(
			t,
			got,
			"RESOURCE\tSENDER\tTIME\tTEXT\n"+
				"spaces/aaa/messages/m1\tAda Lovelace\t2026-06-12T12:00:00Z\tline one line two\n",
		)
	})

	t.Run("threads", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*chatMessageThreadItem{{
			thread: "spaces/aaa/threads/t1",
			message: &chat.Message{
				Name:         "spaces/aaa/messages/m1",
				ArgumentText: "thread\rsummary",
				CreateTime:   "2026-06-12T12:00:00Z",
				Sender:       &chat.User{Name: "users/123"},
			},
		}}, chatThreadColumns())
		assertTableOutput(
			t,
			got,
			"THREAD\tMESSAGE\tSENDER\tTIME\tTEXT\n"+
				"spaces/aaa/threads/t1\tspaces/aaa/messages/m1\tusers/123\t"+
				"2026-06-12T12:00:00Z\tthread summary\n",
		)
	})

	t.Run("reactions", func(t *testing.T) {
		t.Parallel()
		got := renderPlainTable(t, []*chat.Reaction{{
			Name:  "spaces/aaa/messages/m1/reactions/r1",
			Emoji: &chat.Emoji{Unicode: "+1"},
			User:  &chat.User{DisplayName: "Ada"},
		}}, chatReactionColumns())
		assertTableOutput(
			t,
			got,
			"RESOURCE\tEMOJI\tUSER\nspaces/aaa/messages/m1/reactions/r1\t+1\tAda\n",
		)
	})
}

func TestCompactChatRows(t *testing.T) {
	t.Parallel()

	space := &chat.Space{Name: "spaces/aaa"}
	rows := compactChatRows([]*chat.Space{nil, space, nil})
	if len(rows) != 1 || rows[0] != space {
		t.Fatalf("rows = %#v, want only spaces/aaa", rows)
	}

	message := &chat.Message{Name: "spaces/aaa/messages/m1"}
	threadRows := compactChatThreadRows([]*chatMessageThreadItem{
		nil,
		{},
		{thread: "spaces/aaa/threads/t1", message: message},
	})
	if len(threadRows) != 1 || threadRows[0].message != message {
		t.Fatalf("thread rows = %#v, want only message m1", threadRows)
	}
}
