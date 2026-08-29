package cmd

import (
	"context"
	"io"
	"testing"

	"google.golang.org/api/gmail/v1"
)

func TestGmailListMaxValidationBeforeService(t *testing.T) {
	ctx := withGmailTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*gmail.Service, error) {
			t.Fatal("gmail service should not be created")
			return nil, context.Canceled
		},
	)
	flags := &RootFlags{Account: "a@b.com"}

	cases := []struct {
		name string
		run  func() error
	}{
		{name: "search", run: func() error {
			return (&GmailSearchCmd{Query: []string{"newer_than:1d"}, Max: -1}).Run(ctx, flags)
		}},
		{name: "messages-search", run: func() error {
			return (&GmailMessagesSearchCmd{Query: []string{"newer_than:1d"}, Max: -1}).Run(ctx, flags)
		}},
		{name: "drafts-list", run: func() error {
			return (&GmailDraftsListCmd{Max: -1}).Run(ctx, flags)
		}},
		{name: "history", run: func() error {
			return (&GmailHistoryCmd{Since: "100", Max: -1}).Run(ctx, flags)
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run()
			if err == nil {
				t.Fatal("expected max validation error")
			}
			if got := ExitCode(err); got != 2 {
				t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
			}
		})
	}
}
