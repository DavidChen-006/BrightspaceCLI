package cmd

import (
	"strings"

	"google.golang.org/api/chat/v1"
)

type chatSpaceCreateInput struct {
	DisplayName string
	Members     []string
}

type chatSpaceCreatePlan struct {
	DisplayName string
	Members     []string
	MemberUsers []string
	Request     *chat.SetUpSpaceRequest
}

func newChatSpaceCreatePlan(input chatSpaceCreateInput) (chatSpaceCreatePlan, error) {
	plan := chatSpaceCreatePlan{
		DisplayName: strings.TrimSpace(input.DisplayName),
		Members:     parseCommaArgs(input.Members),
	}
	if plan.DisplayName == "" {
		return chatSpaceCreatePlan{}, usage("required: displayName")
	}

	memberships := make([]*chat.Membership, 0, len(plan.Members))
	plan.MemberUsers = make([]string, 0, len(plan.Members))
	for _, member := range plan.Members {
		user, err := normalizeChatMemberUser(member)
		if err != nil {
			return chatSpaceCreatePlan{}, err
		}
		if user == "" {
			continue
		}
		plan.MemberUsers = append(plan.MemberUsers, user)
		memberships = append(memberships, &chat.Membership{
			Member: &chat.User{
				Name: user,
				Type: "HUMAN",
			},
		})
	}

	plan.Request = &chat.SetUpSpaceRequest{
		Space: &chat.Space{
			SpaceType:   "SPACE",
			DisplayName: plan.DisplayName,
		},
	}
	if len(memberships) > 0 {
		plan.Request.Memberships = memberships
	}
	return plan, nil
}

func (p chatSpaceCreatePlan) dryRunPayload() map[string]any {
	return map[string]any{
		"display_name": p.DisplayName,
		"members":      p.Members,
		"member_users": p.MemberUsers,
	}
}
