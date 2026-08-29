package config

import "testing"

func testSystemLayout(tb testing.TB, kinds ...PathKind) Layout {
	tb.Helper()

	layout, err := NewSystemResolver("").Resolve(kinds...)
	if err != nil {
		tb.Fatalf("resolve test layout: %v", err)
	}

	return layout
}

func testClientCredentialsStore(tb testing.TB) *ClientCredentialsStore {
	tb.Helper()

	return NewClientCredentialsStore(testSystemLayout(tb, PathKindConfig, PathKindData))
}
