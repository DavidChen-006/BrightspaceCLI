package cmd

func validateGmailSettingsEmail(flag, email string) error {
	return validatePlainEmail(flag, email)
}
