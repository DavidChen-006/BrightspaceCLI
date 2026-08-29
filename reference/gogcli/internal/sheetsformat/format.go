package sheetsformat

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strings"

	"google.golang.org/api/sheets/v4"
)

const UserEnteredFormatPrefix = "userEnteredFormat"

var (
	errEmptyFormatField       = errors.New("empty format field")
	errFormatRequired         = errors.New("format is required")
	errInvalidForceSendFields = errors.New("invalid ForceSendFields")
	errMissingForceSendFields = errors.New("missing ForceSendFields")
	errMultipleJSONValues     = errors.New("multiple JSON values")
	errNonNilPointerRequired  = errors.New("format must be a non-nil pointer")
	errNotAddressable         = errors.New("field is not addressable")
	errNotStruct              = errors.New("field is not a struct")
	errUnknownField           = errors.New("unknown field")
)

type ValidationError string

func (e ValidationError) Error() string {
	return string(e)
}

func Decode(data []byte, dst *sheets.CellFormat) error {
	if dst == nil {
		return errFormatRequired
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()

	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("decode cell format: %w", err)
	}

	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return errMultipleJSONValues
		}

		return fmt.Errorf("decode trailing cell format data: %w", err)
	}

	return nil
}

func NormalizeMask(mask string) (string, []string) {
	parts := splitFieldMask(mask)
	if len(parts) == 0 {
		return "", nil
	}

	normalized := make([]string, 0, len(parts))

	formatJSONPaths := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}

		switch {
		case part == UserEnteredFormatPrefix:
			normalized = append(normalized, part)
		case strings.HasPrefix(part, UserEnteredFormatPrefix+"."):
			formatPath := strings.TrimPrefix(part, UserEnteredFormatPrefix+".")

			normalized = append(normalized, part)
			if formatPath != "" {
				formatJSONPaths = append(formatJSONPaths, formatPath)
			}
		default:
			if isFormatJSONPath(part) {
				normalized = append(normalized, UserEnteredFormatPrefix+"."+part)
				formatJSONPaths = append(formatJSONPaths, part)
			} else {
				normalized = append(normalized, part)
			}
		}
	}

	return strings.Join(normalized, ","), formatJSONPaths
}

func InferMask(data []byte) (string, []string, error) {
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()

	if err := dec.Decode(&raw); err != nil {
		return "", nil, fmt.Errorf("decode format JSON: %w", err)
	}

	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return "", nil, errMultipleJSONValues
		}

		return "", nil, fmt.Errorf("decode trailing format JSON data: %w", err)
	}

	paths := make([]string, 0)
	collectJSONLeafPaths("", raw, &paths)
	sort.Strings(paths)

	if len(paths) == 0 {
		return "", nil, ValidationError("format JSON did not contain any format fields")
	}
	normalized, formatPaths := NormalizeMask(strings.Join(paths, ","))

	return normalized, formatPaths, nil
}

func ApplyForceSendFields(format *sheets.CellFormat, formatPaths []string) error {
	if format == nil {
		return errFormatRequired
	}

	for _, path := range formatPaths {
		if strings.TrimSpace(path) == "" {
			continue
		}

		if err := forceSendJSONField(format, path); err != nil {
			return fmt.Errorf("invalid format field %q: %w", path, err)
		}
	}

	return nil
}

func HasBordersTypo(mask string) bool {
	for _, part := range splitFieldMask(mask) {
		for _, token := range strings.Split(part, ".") {
			if strings.EqualFold(strings.TrimSpace(token), "boarders") {
				return true
			}
		}
	}

	return false
}

func collectJSONLeafPaths(prefix string, value any, paths *[]string) {
	switch typed := value.(type) {
	case map[string]any:
		if len(typed) == 0 {
			if prefix != "" {
				*paths = append(*paths, prefix)
			}

			return
		}

		for key, child := range typed {
			if strings.TrimSpace(key) == "" {
				continue
			}

			next := key
			if prefix != "" {
				next = prefix + "." + key
			}

			collectJSONLeafPaths(next, child, paths)
		}
	default:
		if prefix != "" {
			*paths = append(*paths, prefix)
		}
	}
}

func splitFieldMask(mask string) []string {
	if strings.TrimSpace(mask) == "" {
		return nil
	}

	parts := strings.Split(mask, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}

	return parts
}

func isFormatJSONPath(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	var format sheets.CellFormat

	return forceSendJSONField(&format, path) == nil
}

func forceSendJSONField(root any, jsonPath string) error {
	parent, fieldValue, fieldName, err := resolveJSONField(root, jsonPath)
	if err != nil {
		return err
	}

	if fieldValue.Kind() == reflect.Pointer && fieldValue.IsNil() && fieldValue.Type().Elem().Kind() == reflect.Struct {
		fieldValue.Set(reflect.New(fieldValue.Type().Elem()))
	}

	return addForceSendField(parent, fieldName)
}

func findJSONField(v reflect.Value, jsonName string) (reflect.Value, string, bool) {
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		if field.PkgPath != "" {
			continue
		}

		tag := field.Tag.Get("json")
		if tag == "-" {
			continue
		}

		name := strings.Split(tag, ",")[0]
		if name == "" {
			continue
		}

		if name == jsonName {
			return v.Field(i), field.Name, true
		}
	}

	return reflect.Value{}, "", false
}

func addForceSendField(v reflect.Value, fieldName string) error {
	forceSendFields := v.FieldByName("ForceSendFields")
	if !forceSendFields.IsValid() {
		return errMissingForceSendFields
	}

	if forceSendFields.Kind() != reflect.Slice || forceSendFields.Type().Elem().Kind() != reflect.String {
		return errInvalidForceSendFields
	}

	for i := 0; i < forceSendFields.Len(); i++ {
		if forceSendFields.Index(i).String() == fieldName {
			return nil
		}
	}

	forceSendFields.Set(reflect.Append(forceSendFields, reflect.ValueOf(fieldName)))

	return nil
}

func resolveJSONField(root any, jsonPath string) (reflect.Value, reflect.Value, string, error) {
	current := reflect.ValueOf(root)
	if current.Kind() != reflect.Pointer || current.IsNil() {
		return reflect.Value{}, reflect.Value{}, "", errNonNilPointerRequired
	}

	parts := strings.Split(jsonPath, ".")
	for i, part := range parts {
		structValue, err := ensureStructValue(current, part)
		if err != nil {
			return reflect.Value{}, reflect.Value{}, "", err
		}

		fieldValue, fieldName, ok := findJSONField(structValue, part)
		if !ok {
			return reflect.Value{}, reflect.Value{}, "", fmt.Errorf("%w %q", errUnknownField, part)
		}

		if i == len(parts)-1 {
			return structValue, fieldValue, fieldName, nil
		}

		next, err := nextStructPointer(fieldValue, part)
		if err != nil {
			return reflect.Value{}, reflect.Value{}, "", err
		}
		current = next
	}

	return reflect.Value{}, reflect.Value{}, "", errEmptyFormatField
}

func ensureStructValue(value reflect.Value, label string) (reflect.Value, error) {
	if value.Kind() == reflect.Pointer {
		if value.IsNil() {
			if value.Type().Elem().Kind() != reflect.Struct {
				return reflect.Value{}, fmt.Errorf("%w %q", errNotStruct, label)
			}

			value.Set(reflect.New(value.Type().Elem()))
		}
		value = value.Elem()
	}

	if value.Kind() != reflect.Struct {
		return reflect.Value{}, fmt.Errorf("%w %q", errNotStruct, label)
	}

	return value, nil
}

func nextStructPointer(value reflect.Value, label string) (reflect.Value, error) {
	switch value.Kind() {
	case reflect.Pointer:
		if value.IsNil() {
			if value.Type().Elem().Kind() != reflect.Struct {
				return reflect.Value{}, fmt.Errorf("%w %q", errNotStruct, label)
			}

			value.Set(reflect.New(value.Type().Elem()))
		}

		return value, nil
	case reflect.Struct:
		if !value.CanAddr() {
			return reflect.Value{}, fmt.Errorf("%w %q", errNotAddressable, label)
		}

		return value.Addr(), nil
	default:
		return reflect.Value{}, fmt.Errorf("%w %q", errNotStruct, label)
	}
}
