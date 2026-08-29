package cmd

import (
	"strings"
	"testing"
)

func TestExecute_Completion_Bash(t *testing.T) {
	result := executeWithTestRuntime(t, []string{"completion", "bash"}, nil)
	if result.err != nil {
		t.Fatalf("Execute: %v", result.err)
	}
	out := result.stdout
	if !strings.Contains(out, "__complete") || !strings.Contains(out, "complete -F _gog_complete gog") {
		excerpt := out
		if len(excerpt) > 200 {
			excerpt = excerpt[:200]
		}
		t.Fatalf("unexpected out=%q", excerpt)
	}
}
