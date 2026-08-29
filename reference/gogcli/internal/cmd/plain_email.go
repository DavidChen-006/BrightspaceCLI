package cmd

import (
	"net/mail"
	"strings"
)

func validatePlainEmail(flag, email string) error {
	email = strings.TrimSpace(email)
	addr, err := mail.ParseAddress(email)
	if err != nil || addr == nil || addr.Address != email || addr.Name != "" {
		return usagef("invalid %s %q", flag, email)
	}
	return nil
}
