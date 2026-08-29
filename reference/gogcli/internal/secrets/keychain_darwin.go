//go:build darwin

package secrets

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/term"
)

const (
	// errSecInteractionNotAllowed is macOS Security framework error -25308
	errSecInteractionNotAllowed = "-25308"
)

var (
	errKeychainPathUnknown = errors.New("cannot determine login keychain path")
	errKeychainNoTTY       = errors.New("keychain is locked and no TTY available for password prompt")
	errKeychainUnlock      = errors.New("unlock keychain: incorrect password or keychain error")
)

// IsKeychainLockedError returns true if the error string indicates a locked keychain.
func IsKeychainLockedError(errStr string) bool {
	return strings.Contains(errStr, errSecInteractionNotAllowed)
}

// loginKeychainPath returns the path to the user's login keychain.
func loginKeychainPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}

	return filepath.Join(home, "Library", "Keychains", "login.keychain-db")
}

func checkKeychainLocked(ctx context.Context) bool {
	path := loginKeychainPath()
	if path == "" {
		return false
	}

	cmd := exec.CommandContext(ctx, "security", "show-keychain-info", path) //nolint:gosec // path is from os.UserHomeDir, not user input
	err := cmd.Run()
	// Exit code 0 = unlocked, non-zero = locked or error
	return err != nil
}

func unlockKeychain(ctx context.Context) error {
	path := loginKeychainPath()
	if path == "" {
		return errKeychainPathUnknown
	}

	// Check if we have a TTY for password input
	if !term.IsTerminal(int(syscall.Stdin)) {
		return fmt.Errorf("%w\n\nTo unlock manually, run:\n  security unlock-keychain ~/Library/Keychains/login.keychain-db", errKeychainNoTTY)
	}

	fmt.Fprint(os.Stderr, "Keychain is locked. Enter your macOS login password to unlock: ")

	password, err := term.ReadPassword(int(syscall.Stdin))

	fmt.Fprintln(os.Stderr) // newline after password input

	if err != nil {
		return fmt.Errorf("read password: %w", err)
	}

	// Pass password via stdin to avoid exposing it in process list (ps aux)
	cmd := exec.CommandContext(ctx, "security", "unlock-keychain", path) //nolint:gosec // path is from os.UserHomeDir
	cmd.Stdin = strings.NewReader(string(password) + "\n")

	if err := cmd.Run(); err != nil {
		return errKeychainUnlock
	}

	return nil
}

func EnsureKeychainAccessContext(ctx context.Context) error {
	if !checkKeychainLocked(ctx) {
		return nil
	}

	return unlockKeychain(ctx)
}
