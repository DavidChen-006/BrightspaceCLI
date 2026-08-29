package cmd

import (
	"regexp"
	"strings"
	"time"
)

var (
	calendarRFC3339ShapeRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`)
	calendarDateShapeRE    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

func validateCalendarDateTimeFlag(flagName, value string) error {
	value = strings.TrimSpace(value)
	if !calendarRFC3339ShapeRE.MatchString(value) {
		return usagef("%s must be RFC3339 datetime", flagName)
	}
	if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
		return usagef("%s must be RFC3339 datetime", flagName)
	}
	return nil
}

func validateCalendarDateFlag(flagName, value string) error {
	value = strings.TrimSpace(value)
	if !calendarDateShapeRE.MatchString(value) {
		return usagef("%s must be YYYY-MM-DD date", flagName)
	}
	if _, err := time.Parse("2006-01-02", value); err != nil {
		return usagef("%s must be YYYY-MM-DD date", flagName)
	}
	return nil
}
