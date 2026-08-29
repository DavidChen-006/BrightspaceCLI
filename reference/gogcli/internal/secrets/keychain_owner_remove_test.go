package secrets

import (
	"errors"
	"strings"
	"testing"

	"github.com/99designs/keyring"
)

type ownerRemoveTestKeyring struct {
	keyring.Keyring
	removeErr error
}

var (
	errOwnerRemoveDenied        = errors.New("denied")
	errOwnerRemoveChanged       = errors.New("keychain error. (-25244)")
	errOwnerRemoveFallback      = errors.New("native delete failed")
	errOwnerRemoveNamed         = errors.New("errSecInvalidOwnerEdit")
	errOwnerRemoveDescription   = errors.New("invalid owner edit")
	errOwnerRemoveNotApplicable = errors.New("permission denied")
)

func (k ownerRemoveTestKeyring) Remove(string) error {
	return k.removeErr
}

func TestKeychainOwnerRemoveFallback(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name             string
		primaryErr       error
		fallbackErr      error
		wantErrContains  string
		wantFallbackCall bool
	}{
		{name: "primary success"},
		{name: "missing", primaryErr: keyring.ErrKeyNotFound, wantErrContains: keyring.ErrKeyNotFound.Error()},
		{name: "other error", primaryErr: errOwnerRemoveDenied, wantErrContains: "denied"},
		{name: "owner changed", primaryErr: errOwnerRemoveChanged, wantFallbackCall: true},
		{
			name:             "fallback error",
			primaryErr:       errOwnerRemoveChanged,
			fallbackErr:      errOwnerRemoveFallback,
			wantErrContains:  "native delete failed",
			wantFallbackCall: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			fallbackCalled := false
			ring := newKeychainOwnerRemoveFallback(
				ownerRemoveTestKeyring{removeErr: tt.primaryErr},
				"release-proof-service",
				func(service string, account string) error {
					fallbackCalled = true

					if service != "release-proof-service" || account != "release-proof-account" {
						t.Fatalf("fallback target = %q/%q", service, account)
					}

					return tt.fallbackErr
				},
			)

			err := ring.Remove("release-proof-account")

			if fallbackCalled != tt.wantFallbackCall {
				t.Fatalf("fallback called = %t, want %t", fallbackCalled, tt.wantFallbackCall)
			}

			if tt.wantErrContains == "" {
				if err != nil {
					t.Fatalf("Remove: %v", err)
				}

				return
			}

			if err == nil || !strings.Contains(err.Error(), tt.wantErrContains) {
				t.Fatalf("Remove error = %v, want containing %q", err, tt.wantErrContains)
			}
		})
	}
}

func TestIsKeychainInvalidOwnerEdit(t *testing.T) {
	t.Parallel()

	for _, err := range []error{
		errOwnerRemoveChanged,
		errOwnerRemoveNamed,
		errOwnerRemoveDescription,
	} {
		if !isKeychainInvalidOwnerEdit(err) {
			t.Fatalf("expected invalid-owner match for %q", err)
		}
	}

	if isKeychainInvalidOwnerEdit(errOwnerRemoveNotApplicable) {
		t.Fatal("unexpected invalid-owner match")
	}
}
