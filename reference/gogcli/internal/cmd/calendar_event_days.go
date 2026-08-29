package cmd

import (
	"encoding/json"
	"strings"
	"time"

	"google.golang.org/api/calendar/v3"
)

type eventWithDays struct {
	*calendar.Event
	StartDayOfWeek string `json:"startDayOfWeek,omitempty"`
	EndDayOfWeek   string `json:"endDayOfWeek,omitempty"`
	Timezone       string `json:"timezone,omitempty"`
	EventTimezone  string `json:"eventTimezone,omitempty"`
	StartLocal     string `json:"startLocal,omitempty"`
	EndLocal       string `json:"endLocal,omitempty"`
}

func (e *eventWithDays) MarshalJSON() ([]byte, error) {
	if e == nil {
		return []byte("null"), nil
	}
	return marshalCalendarEventWithFields(e.Event, map[string]string{
		"startDayOfWeek": e.StartDayOfWeek,
		"endDayOfWeek":   e.EndDayOfWeek,
		"timezone":       e.Timezone,
		"eventTimezone":  e.EventTimezone,
		"startLocal":     e.StartLocal,
		"endLocal":       e.EndLocal,
	})
}

func wrapEventsWithDays(events []*calendar.Event) []*eventWithDays {
	if len(events) == 0 {
		return []*eventWithDays{}
	}
	out := make([]*eventWithDays, 0, len(events))
	for _, ev := range events {
		out = append(out, wrapEventWithDaysWithTimezone(ev, "", nil))
	}
	return out
}

func wrapEventWithDaysWithTimezone(event *calendar.Event, calendarTimezone string, loc *time.Location) *eventWithDays {
	return wrapEventWithDaysWithTimezoneOverride(event, calendarTimezone, loc, false)
}

func wrapEventWithDaysWithTimezoneOverride(event *calendar.Event, calendarTimezone string, loc *time.Location, forceDisplayTimezone bool) *eventWithDays {
	if event == nil {
		return nil
	}
	evTimezone := eventTimezone(event)
	startLoc, endLoc := loc, loc
	if forceDisplayTimezone {
		calendarTimezone = strings.TrimSpace(calendarTimezone)
	} else {
		fallbackTimezone, fallbackLoc := calendarTimezone, loc
		calendarTimezone = resolveEventTimezone(event, calendarTimezone, loc)
		startLoc = resolveEventDateTimeTimezone(event.Start, fallbackTimezone, fallbackLoc)
		endLoc = resolveEventDateTimeTimezone(event.End, fallbackTimezone, fallbackLoc)
	}
	startDay := dayOfWeekFromEventDateTime(event.Start, startLoc)
	endDay := dayOfWeekFromEventDateTime(event.End, endLoc)

	startLocal := formatEventLocal(event.Start, startLoc)
	endLocal := formatEventLocal(event.End, endLoc)

	wrapped := &eventWithDays{
		Event:          event,
		StartDayOfWeek: startDay,
		EndDayOfWeek:   endDay,
		Timezone:       calendarTimezone,
		StartLocal:     startLocal,
		EndLocal:       endLocal,
	}
	if evTimezone != "" && evTimezone != calendarTimezone {
		wrapped.EventTimezone = evTimezone
	}
	return wrapped
}

func eventDaysOfWeek(event *calendar.Event) (string, string) {
	return eventDaysOfWeekInLocation(event, nil)
}

func eventDaysOfWeekInLocation(event *calendar.Event, loc *time.Location) (string, string) {
	if event == nil {
		return "", ""
	}
	startDay := dayOfWeekFromEventDateTime(event.Start, loc)
	endDay := dayOfWeekFromEventDateTime(event.End, loc)
	return startDay, endDay
}

func dayOfWeekFromEventDateTime(dt *calendar.EventDateTime, loc *time.Location) string {
	if dt == nil {
		return ""
	}
	if dt.DateTime != "" {
		if t, ok := parseEventTime(dt.DateTime, dt.TimeZone); ok {
			if loc != nil {
				t = t.In(loc)
			}
			return t.Weekday().String()
		}
	}
	if dt.Date != "" {
		if t, ok := parseEventDate(dt.Date, dt.TimeZone); ok {
			return t.Weekday().String()
		}
	}
	return ""
}

func parseEventTime(value string, tz string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		if loc, ok := loadEventLocation(tz); ok {
			return t.In(loc), true
		}
		return t, true
	}
	if t, err := time.Parse(time.RFC3339Nano, value); err == nil {
		if loc, ok := loadEventLocation(tz); ok {
			return t.In(loc), true
		}
		return t, true
	}
	if loc, ok := loadEventLocation(tz); ok {
		if t, err := time.ParseInLocation("2006-01-02T15:04:05", value, loc); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func parseEventDate(value string, tz string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false
	}
	if loc, ok := loadEventLocation(tz); ok {
		if t, err := time.ParseInLocation("2006-01-02", value, loc); err == nil {
			return t, true
		}
	} else if t, err := time.Parse("2006-01-02", value); err == nil {
		return t, true
	}
	return time.Time{}, false
}

func loadEventLocation(tz string) (*time.Location, bool) {
	return tryLoadTimezoneLocation(tz)
}

// resolveEventTimezone resolves the timezone and location used for local
// event display. Prefer the event's own timezone over the containing
// calendar timezone: Google Calendar may return a DateTime rendered with the
// calendar's UTC offset while also carrying the event timezone field. Showing
// local fields in the calendar timezone makes conference/travel events look an
// hour early/late (for example an Asia/Seoul event on an Asia/Hong_Kong
// calendar). Fall back to the calendar timezone only when the event has none.
func resolveEventTimezone(event *calendar.Event, calendarTimezone string, loc *time.Location) string {
	calendarTimezone = strings.TrimSpace(calendarTimezone)
	evTimezone := eventTimezone(event)

	if evTimezone != "" {
		if _, ok := tryLoadTimezoneLocation(evTimezone); ok {
			return evTimezone
		}
	}

	if calendarTimezone != "" {
		if loc != nil {
			return calendarTimezone
		}
		if _, ok := tryLoadTimezoneLocation(calendarTimezone); ok {
			return calendarTimezone
		}
	}

	return ""
}

func resolveEventDateTimeTimezone(dt *calendar.EventDateTime, fallbackTimezone string, fallbackLoc *time.Location) *time.Location {
	if dt != nil {
		tz := strings.TrimSpace(dt.TimeZone)
		if tz != "" {
			if loaded, ok := tryLoadTimezoneLocation(tz); ok {
				return loaded
			}
		}
	}

	fallbackTimezone = strings.TrimSpace(fallbackTimezone)
	if fallbackTimezone == "" {
		return nil
	}
	if fallbackLoc != nil {
		return fallbackLoc
	}
	if loaded, ok := tryLoadTimezoneLocation(fallbackTimezone); ok {
		return loaded
	}
	return nil
}

func marshalCalendarEventWithFields(event *calendar.Event, fields map[string]string) ([]byte, error) {
	raw := map[string]any{}
	if event != nil {
		data, err := json.Marshal(event)
		if err != nil {
			return nil, err
		}
		if string(data) != "null" {
			if err := json.Unmarshal(data, &raw); err != nil {
				return nil, err
			}
		}
	}
	for key, value := range fields {
		if value != "" {
			raw[key] = value
		}
	}
	return json.Marshal(raw)
}
