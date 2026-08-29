package cmd

import (
	"fmt"
	"reflect"
	"strings"

	"google.golang.org/api/calendar/v3"
)

func eventHasConferenceLink(event *calendar.Event) bool {
	if event == nil {
		return false
	}
	if strings.TrimSpace(event.HangoutLink) != "" {
		return true
	}
	if event.ConferenceData == nil {
		return false
	}
	for _, ep := range event.ConferenceData.EntryPoints {
		if ep != nil && strings.TrimSpace(ep.Uri) != "" {
			return true
		}
	}
	return false
}

func patchOnlyConferenceData(event *calendar.Event) bool {
	if event == nil || !patchHasConferenceDataMutation(event) {
		return false
	}
	clone := *event
	clone.ConferenceData = nil
	clone.NullFields = removeStringField(clone.NullFields, "ConferenceData")
	return reflect.DeepEqual(clone, calendar.Event{})
}

func validateZoomConferenceFlagMutex(fields calendarUpdateFields) error {
	type selectedFlag struct {
		name     string
		selected bool
	}
	pairs := [][2]selectedFlag{
		{{name: "with-zoom", selected: fields.WithZoom}, {name: "regenerate-zoom", selected: fields.RegenerateZoom}},
		{{name: "with-zoom", selected: fields.WithZoom}, {name: "remove-zoom", selected: fields.RemoveZoom}},
		{{name: "regenerate-zoom", selected: fields.RegenerateZoom}, {name: "remove-zoom", selected: fields.RemoveZoom}},
		{{name: "with-zoom", selected: fields.WithZoom}, {name: "with-meet", selected: fields.WithMeet}},
		{{name: "with-zoom", selected: fields.WithZoom}, {name: "regenerate-meet", selected: fields.RegenerateMeet}},
		{{name: "regenerate-zoom", selected: fields.RegenerateZoom}, {name: "with-meet", selected: fields.WithMeet}},
		{{name: "regenerate-zoom", selected: fields.RegenerateZoom}, {name: "regenerate-meet", selected: fields.RegenerateMeet}},
	}
	for _, pair := range pairs {
		if pair[0].selected && pair[1].selected {
			return usage(fmt.Sprintf("use only one of --%s or --%s", pair[0].name, pair[1].name))
		}
	}
	return nil
}

func zoomUpdateDryRunPayload(fields calendarUpdateFields) map[string]any {
	switch {
	case fields.WithZoom:
		return zoomDryRunPayload("create")
	case fields.RegenerateZoom:
		return zoomDryRunPayload("regenerate")
	case fields.RemoveZoom:
		return zoomDryRunPayload("remove")
	default:
		return nil
	}
}

func zoomDryRunPayload(action string) map[string]any {
	return map[string]any{
		"action":           action,
		"description_mode": true,
	}
}

func mergeEventPatch(existing, patch *calendar.Event) *calendar.Event {
	if existing == nil {
		return patch
	}
	merged := *existing
	if patch == nil {
		return &merged
	}
	if strings.TrimSpace(patch.Summary) != "" {
		merged.Summary = patch.Summary
	}
	if strings.TrimSpace(patch.Description) != "" || forceSendsField(patch, "Description") {
		merged.Description = patch.Description
	}
	if patch.Start != nil {
		merged.Start = patch.Start
	}
	if patch.End != nil {
		merged.End = patch.End
	}
	return &merged
}

func patchHasConferenceDataMutation(event *calendar.Event) bool {
	if event == nil {
		return false
	}
	if event.ConferenceData != nil {
		return true
	}
	for _, field := range event.NullFields {
		if field == "ConferenceData" {
			return true
		}
	}
	return false
}

func patchEffectivelyEmpty(event *calendar.Event) bool {
	return event == nil || reflect.DeepEqual(*event, calendar.Event{})
}

func removeStringField(fields []string, value string) []string {
	out := fields[:0]
	for _, field := range fields {
		if field != value {
			out = append(out, field)
		}
	}
	return out
}
