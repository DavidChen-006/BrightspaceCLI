package secrets

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"github.com/99designs/keyring"
)

const errSecInvalidOwnerEditCode = "-25244"

type keychainOwnerRemoveFunc func(service string, account string) error

type keychainOwnerRemoveFallback struct {
	keyring.Keyring
	service string
	remove  keychainOwnerRemoveFunc
}

func newKeychainOwnerRemoveFallback(
	ring keyring.Keyring,
	service string,
	remove keychainOwnerRemoveFunc,
) keyring.Keyring {
	return &keychainOwnerRemoveFallback{
		Keyring: ring,
		service: service,
		remove:  remove,
	}
}

func (k *keychainOwnerRemoveFallback) Remove(key string) error {
	err := k.Keyring.Remove(key)
	if err == nil {
		return nil
	}

	if errors.Is(err, keyring.ErrKeyNotFound) || !isKeychainInvalidOwnerEdit(err) {
		return fmt.Errorf("remove keychain item: %w", err)
	}

	// A trusted Developer-ID successor can read an item created by the prior
	// binary, but macOS still reserves ACL-owner deletion for the creator.
	if removeErr := k.remove(k.service, key); removeErr != nil {
		return fmt.Errorf("remove upgraded keychain item (original: %w): %w", err, removeErr)
	}

	return nil
}

func isKeychainInvalidOwnerEdit(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())

	return strings.Contains(message, errSecInvalidOwnerEditCode) ||
		strings.Contains(message, "errsecinvalidowneredit") ||
		strings.Contains(message, "invalid owner edit")
}

func nativeKeychainOwnerRemove(service string, account string) error {
	ctx, cancel := context.WithTimeout(context.Background(), codesignTimeout)
	defer cancel()

	// Values are passed as argv, not through a shell. The native tool owns the
	// existing user's Keychain authorization and receives no secret material.
	//nolint:gosec // fixed executable; service and account are passed as argv without a shell
	if err := exec.CommandContext(
		ctx,
		"/usr/bin/security",
		"delete-generic-password",
		"-s", service,
		"-a", account,
	).Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("security delete-generic-password timed out: %w", ctx.Err())
		}

		return fmt.Errorf("security delete-generic-password: %w", err)
	}

	return nil
}
