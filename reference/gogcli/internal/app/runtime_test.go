package app

import (
	"bytes"
	"context"
	"testing"
)

func TestRuntimeContext(t *testing.T) {
	t.Parallel()

	var stdout bytes.Buffer
	runtime := &Runtime{IO: IO{Out: &stdout}}
	ctx := WithRuntime(context.Background(), runtime)

	got, ok := FromContext(ctx)
	if !ok || got != runtime {
		t.Fatalf("FromContext() = (%p, %v), want (%p, true)", got, ok, runtime)
	}

	gotIO, ok := IOFromContext(ctx)
	if !ok || gotIO.Out != &stdout {
		t.Fatalf("IOFromContext() = (%#v, %v), want stdout runtime IO", gotIO, ok)
	}
}

func TestRuntimeContextMissing(t *testing.T) {
	t.Parallel()

	if got, ok := FromContext(context.Background()); ok || got != nil {
		t.Fatalf("FromContext() = (%p, %v), want (nil, false)", got, ok)
	}

	if got, ok := IOFromContext(context.Background()); ok || got != (IO{}) {
		t.Fatalf("IOFromContext() = (%#v, %v), want zero IO and false", got, ok)
	}
}
