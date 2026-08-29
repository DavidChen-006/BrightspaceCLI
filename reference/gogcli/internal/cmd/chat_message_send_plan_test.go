package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/api/chat/v1"
)

func TestNewChatMessageSendPlan(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}

	plan, err := newChatMessageSendPlan(chatMessageSendInput{
		Space:       "AAA",
		Text:        "  hello  ",
		Thread:      " t1 ",
		Attachments: []string{"~/pic.png"},
	})
	if err != nil {
		t.Fatalf("newChatMessageSendPlan: %v", err)
	}
	if plan.Space != "spaces/AAA" || plan.Text != "hello" {
		t.Fatalf("unexpected message plan: %#v", plan)
	}
	if plan.ThreadRaw != "t1" || plan.ThreadName != "spaces/AAA/threads/t1" {
		t.Fatalf("unexpected thread plan: %#v", plan)
	}
	if len(plan.Attachments) != 1 || plan.Attachments[0] != filepath.Join(home, "pic.png") {
		t.Fatalf("unexpected attachments: %#v", plan.Attachments)
	}
	if plan.replyOption() != chatReplyFallbackToNewThread {
		t.Fatalf("replyOption() = %q", plan.replyOption())
	}

	attachment := &chat.Attachment{}
	message := plan.message([]*chat.Attachment{attachment})
	if message.Text != "hello" || message.Thread == nil || message.Thread.Name != plan.ThreadName {
		t.Fatalf("unexpected message: %#v", message)
	}
	if len(message.Attachment) != 1 || message.Attachment[0] != attachment {
		t.Fatalf("unexpected message attachments: %#v", message.Attachment)
	}

	payload := plan.dryRunPayload()
	if payload["reply_fallback_to_new_thread"] != true || payload["thread"] != plan.ThreadName {
		t.Fatalf("unexpected dry-run payload: %#v", payload)
	}
}

func TestNewChatMessageSendPlanAttachmentOnly(t *testing.T) {
	plan, err := newChatMessageSendPlan(chatMessageSendInput{
		Space:       "spaces/AAA",
		Attachments: []string{"image.png"},
	})
	if err != nil {
		t.Fatalf("newChatMessageSendPlan: %v", err)
	}
	if plan.Text != "" || plan.ThreadName != "" || plan.replyOption() != "" {
		t.Fatalf("unexpected attachment-only plan: %#v", plan)
	}
}

func TestNewChatMessageSendPlanValidation(t *testing.T) {
	tests := []struct {
		name  string
		input chatMessageSendInput
		want  string
	}{
		{name: "space", input: chatMessageSendInput{Text: "hello"}, want: "required: space"},
		{name: "content", input: chatMessageSendInput{Space: "AAA"}, want: "required: --text or --attach"},
		{name: "attachment", input: chatMessageSendInput{Space: "AAA", Attachments: []string{""}}, want: "attachment path must not be empty"},
		{name: "thread", input: chatMessageSendInput{Space: "AAA", Text: "hello", Thread: "spaces/AAA/threads/t1/extra"}, want: "invalid thread"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := newChatMessageSendPlan(tt.input)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want containing %q", err, tt.want)
			}
		})
	}
}
