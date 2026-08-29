//go:build !darwin

package secrets

import "context"

// IsKeychainLockedError returns false on non-macOS platforms.
func IsKeychainLockedError(_ string) bool {
	return false
}

// EnsureKeychainAccessContext is a no-op on non-macOS platforms.
func EnsureKeychainAccessContext(context.Context) error {
	return nil
}
