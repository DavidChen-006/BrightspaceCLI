package cmd

func appendForceSendField(fields []string, field string) []string {
	for _, existing := range fields {
		if existing == field {
			return fields
		}
	}

	return append(fields, field)
}
