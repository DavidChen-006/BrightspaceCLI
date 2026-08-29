package cmd

import (
	"fmt"
	"strings"

	"google.golang.org/api/chat/v1"
)

const chatReplyFallbackToNewThread = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"

type chatMessageSendInput struct {
	Space       string
	Text        string
	Thread      string
	Attachments []string
}

type chatMessageSendPlan struct {
	Space       string
	Text        string
	ThreadRaw   string
	ThreadName  string
	Attachments []string
}

func newChatMessageSendPlan(input chatMessageSendInput) (chatMessageSendPlan, error) {
	space, err := normalizeSpace(input.Space)
	if err != nil {
		return chatMessageSendPlan{}, usage("required: space")
	}

	attachments, err := expandChatAttachmentPaths(input.Attachments)
	if err != nil {
		return chatMessageSendPlan{}, err
	}

	plan := chatMessageSendPlan{
		Space:       space,
		Text:        strings.TrimSpace(input.Text),
		ThreadRaw:   strings.TrimSpace(input.Thread),
		Attachments: attachments,
	}
	if plan.Text == "" && len(plan.Attachments) == 0 {
		return chatMessageSendPlan{}, usage("required: --text or --attach")
	}
	if plan.ThreadRaw != "" {
		plan.ThreadName, err = normalizeThread(plan.Space, plan.ThreadRaw)
		if err != nil {
			return chatMessageSendPlan{}, usage(fmt.Sprintf("invalid thread: %v", err))
		}
	}
	return plan, nil
}

func (p chatMessageSendPlan) message(attachments []*chat.Attachment) *chat.Message {
	message := &chat.Message{
		Text:       p.Text,
		Attachment: attachments,
	}
	if p.ThreadName != "" {
		message.Thread = &chat.Thread{Name: p.ThreadName}
	}
	return message
}

func (p chatMessageSendPlan) replyOption() string {
	if p.ThreadName == "" {
		return ""
	}
	return chatReplyFallbackToNewThread
}

func (p chatMessageSendPlan) dryRunPayload() map[string]any {
	return map[string]any{
		"space":                        p.Space,
		"text":                         p.Text,
		"thread":                       p.ThreadName,
		"thread_raw":                   p.ThreadRaw,
		"reply_fallback_to_new_thread": p.ThreadName != "",
		"attachments":                  p.Attachments,
	}
}
