package cmd

import (
	"context"
	"errors"
	"io"
	"testing"

	"google.golang.org/api/gmail/v1"
)

func TestGmailSendAsCmd_ValidationErrors(t *testing.T) {
	serviceErrorCtx := withGmailTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*gmail.Service, error) {
			return nil, errors.New("service down")
		},
	)
	if err := (&GmailSendAsListCmd{}).Run(serviceErrorCtx, &RootFlags{}); err == nil {
		t.Fatalf("expected missing account or service error")
	}

	validationCtx := withGmailTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*gmail.Service, error) {
			t.Fatal("gmail service should not be created during validation")
			return nil, context.Canceled
		},
	)
	tests := []struct {
		name string
		run  func() error
	}{
		{name: "get", run: func() error { return (&GmailSendAsGetCmd{}).Run(validationCtx, &RootFlags{Account: "a@b.com"}) }},
		{name: "create", run: func() error { return (&GmailSendAsCreateCmd{}).Run(validationCtx, &RootFlags{Account: "a@b.com"}) }},
		{name: "verify", run: func() error { return (&GmailSendAsVerifyCmd{}).Run(validationCtx, &RootFlags{Account: "a@b.com"}) }},
		{name: "delete", run: func() error { return (&GmailSendAsDeleteCmd{}).Run(validationCtx, &RootFlags{Account: "a@b.com"}) }},
		{name: "update", run: func() error { return (&GmailSendAsUpdateCmd{}).Run(validationCtx, nil, &RootFlags{Account: "a@b.com"}) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.run()
			if err == nil {
				t.Fatal("expected missing email error")
			}
			if got := ExitCode(err); got != 2 {
				t.Fatalf("ExitCode = %d, want 2 (err=%v)", got, err)
			}
		})
	}
}

func TestGmailSendAsListCmd_ServiceError(t *testing.T) {
	ctx := withGmailTestServiceFactory(
		newCmdRuntimeOutputContext(t, io.Discard, io.Discard),
		func(context.Context, string) (*gmail.Service, error) {
			return nil, errors.New("service down")
		},
	)

	if err := (&GmailSendAsListCmd{}).Run(ctx, &RootFlags{Account: "a@b.com"}); err == nil {
		t.Fatalf("expected service error")
	}
}
