package cmd

import (
	"strings"
	"time"
)

type tasksAddInput struct {
	TasklistID  string
	Title       string
	Notes       string
	Due         string
	Parent      string
	Previous    string
	Repeat      string
	Recur       string
	RecurRRule  string
	RepeatCount int
	RepeatUntil string
}

type tasksAddRepeatConfig struct {
	Unit      repeatUnit
	Interval  int
	Repeat    string
	Recur     string
	RecurRule string
	Until     string
}

type tasksAddDatePlan struct {
	DueTime    time.Time
	DueHasTime bool
	DueValue   string
	Until      *time.Time
}

type tasksAddPlan struct {
	TasklistID  string
	Title       string
	Notes       string
	Due         string
	Parent      string
	Previous    string
	RepeatCount int
	Repeat      tasksAddRepeatConfig
	Date        tasksAddDatePlan
}

func newTasksAddPlan(input tasksAddInput) (tasksAddPlan, error) {
	plan := tasksAddPlan{
		TasklistID:  strings.TrimSpace(input.TasklistID),
		Title:       strings.TrimSpace(input.Title),
		Notes:       strings.TrimSpace(input.Notes),
		Due:         strings.TrimSpace(input.Due),
		Parent:      strings.TrimSpace(input.Parent),
		Previous:    strings.TrimSpace(input.Previous),
		RepeatCount: input.RepeatCount,
	}
	if plan.TasklistID == "" {
		return tasksAddPlan{}, usage("empty tasklistId")
	}
	if plan.Title == "" {
		return tasksAddPlan{}, usage("required: --title")
	}

	repeatConfig, err := resolveTasksAddRepeatConfig(input, plan.Due)
	if err != nil {
		return tasksAddPlan{}, err
	}
	datePlan, err := prepareTasksAddDatePlan(plan.Due, repeatConfig)
	if err != nil {
		return tasksAddPlan{}, err
	}
	plan.Repeat = repeatConfig
	plan.Date = datePlan
	return plan, nil
}

func resolveTasksAddRepeatConfig(input tasksAddInput, due string) (tasksAddRepeatConfig, error) {
	config := tasksAddRepeatConfig{
		Interval:  1,
		Repeat:    strings.TrimSpace(input.Repeat),
		Recur:     strings.TrimSpace(input.Recur),
		RecurRule: strings.TrimSpace(input.RecurRRule),
		Until:     strings.TrimSpace(input.RepeatUntil),
	}

	if config.Repeat != "" && (config.Recur != "" || config.RecurRule != "") {
		return tasksAddRepeatConfig{}, usage("--repeat cannot be combined with --recur or --recur-rrule")
	}
	if config.Recur != "" && config.RecurRule != "" {
		return tasksAddRepeatConfig{}, usage("--recur and --recur-rrule are mutually exclusive")
	}

	var err error
	switch {
	case config.RecurRule != "":
		config.Unit, config.Interval, err = parseRepeatRRule(config.RecurRule)
	case config.Recur != "":
		config.Unit, err = parseRepeatUnit(config.Recur)
	default:
		config.Unit, err = parseRepeatUnit(config.Repeat)
	}
	if err != nil {
		return tasksAddRepeatConfig{}, newUsageError(err)
	}

	if config.Unit == repeatNone && (config.Until != "" || input.RepeatCount != 0) {
		return tasksAddRepeatConfig{}, usage("--repeat, --recur, or --recur-rrule is required when using --repeat-count or --repeat-until")
	}
	if config.Unit != repeatNone {
		if due == "" {
			return tasksAddRepeatConfig{}, usage("--due is required when using --repeat, --recur, or --recur-rrule")
		}
		if input.RepeatCount < 0 {
			return tasksAddRepeatConfig{}, usage("--repeat-count must be >= 0")
		}
		if config.Until == "" && input.RepeatCount == 0 {
			if config.Recur != "" || config.RecurRule != "" {
				return tasksAddRepeatConfig{}, usage("Google Tasks API does not support server-side recurring metadata; use --repeat-count or --repeat-until with --recur/--recur-rrule to materialize occurrences")
			}
			return tasksAddRepeatConfig{}, usage("--repeat requires --repeat-count or --repeat-until")
		}
	}
	return config, nil
}

func prepareTasksAddDatePlan(due string, repeatConfig tasksAddRepeatConfig) (tasksAddDatePlan, error) {
	plan := tasksAddDatePlan{}
	due = strings.TrimSpace(due)
	if due == "" {
		return plan, nil
	}

	dueTime, dueHasTime, err := parseTaskDate(due)
	if err != nil {
		return tasksAddDatePlan{}, newUsageError(err)
	}
	plan.DueTime = dueTime
	plan.DueHasTime = dueHasTime
	plan.DueValue = formatTaskDue(dueTime, dueHasTime)

	if repeatConfig.Unit == repeatNone {
		return plan, nil
	}
	if repeatConfig.Until != "" {
		untilValue, untilHasTime, parseErr := parseTaskDate(repeatConfig.Until)
		if parseErr != nil {
			return tasksAddDatePlan{}, newUsageError(parseErr)
		}
		switch {
		case dueHasTime && !untilHasTime:
			untilValue = time.Date(
				untilValue.Year(),
				untilValue.Month(),
				untilValue.Day(),
				dueTime.Hour(),
				dueTime.Minute(),
				dueTime.Second(),
				dueTime.Nanosecond(),
				dueTime.Location(),
			)
		case !dueHasTime && untilHasTime:
			untilValue = time.Date(untilValue.Year(), untilValue.Month(), untilValue.Day(), 0, 0, 0, 0, time.UTC)
		}
		plan.Until = &untilValue
	}
	if plan.Until != nil && dueTime.After(*plan.Until) {
		return tasksAddDatePlan{}, usage("repeat produced no occurrences")
	}
	return plan, nil
}

func (p tasksAddPlan) repeating() bool {
	return p.Repeat.Unit != repeatNone
}

func (p tasksAddPlan) repeatSchedule() ([]time.Time, error) {
	schedule := expandRepeatSchedule(p.Date.DueTime, p.Repeat.Unit, p.Repeat.Interval, p.RepeatCount, p.Date.Until)
	if len(schedule) == 0 {
		return nil, usage("repeat produced no occurrences")
	}
	return schedule, nil
}

func (p tasksAddPlan) dryRunPayload() map[string]any {
	return map[string]any{
		"tasklist_id":  p.TasklistID,
		"title":        p.Title,
		"notes":        p.Notes,
		"due":          p.Due,
		"parent":       p.Parent,
		"previous":     p.Previous,
		"repeat":       p.Repeat.Repeat,
		"recur":        p.Repeat.Recur,
		"recur_rrule":  p.Repeat.RecurRule,
		"repeat_step":  p.Repeat.Interval,
		"repeat_count": p.RepeatCount,
		"repeat_until": p.Repeat.Until,
	}
}
