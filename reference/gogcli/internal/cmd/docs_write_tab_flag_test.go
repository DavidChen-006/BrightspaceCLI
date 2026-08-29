package cmd

import (
	"io"
	"strings"
	"testing"

	"github.com/alecthomas/kong"
)

func TestDocsWrite_ExplicitEmptyTabRejected(t *testing.T) {
	t.Parallel()

	for _, args := range [][]string{
		{"doc1", "--text", "hi", "--tab="},
		{"doc1", "--text", "hi", "--tab", " "},
		{"doc1", "--text", "hi", "--tab-id="},
	} {
		cmd := &DocsWriteCmd{}
		parser, err := kong.New(cmd, kong.Writers(io.Discard, io.Discard))
		if err != nil {
			t.Fatalf("kong.New: %v", err)
		}
		kctx, err := parser.Parse(args)
		if err != nil {
			t.Fatalf("parse %v: %v", args, err)
		}

		ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)
		runErr := cmd.Run(ctx, kctx, &RootFlags{Account: "a@b.com"})
		if runErr == nil {
			t.Fatalf("args %v: expected empty --tab error, got nil", args)
		}
		if !strings.Contains(runErr.Error(), "--tab requires a non-empty tab") {
			t.Fatalf("args %v: unexpected error: %v", args, runErr)
		}
	}
}

func TestDocsWrite_OmittedTabStillTargetsWholeDoc(t *testing.T) {
	t.Parallel()

	cmd := &DocsWriteCmd{}
	parser, err := kong.New(cmd, kong.Writers(io.Discard, io.Discard))
	if err != nil {
		t.Fatalf("kong.New: %v", err)
	}
	kctx, err := parser.Parse([]string{"doc1", "--text", "hi"})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	ctx := newCmdRuntimeOutputContext(t, io.Discard, io.Discard)
	runErr := cmd.Run(ctx, kctx, &RootFlags{Account: "a@b.com"})
	if runErr != nil && strings.Contains(runErr.Error(), "--tab requires") {
		t.Fatalf("omitted --tab must not trip the empty-tab validation, got: %v", runErr)
	}
}
