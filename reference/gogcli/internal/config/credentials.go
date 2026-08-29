//nolint:wsl_v5
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

var (
	errInvalidCredentials      = errors.New("invalid credentials.json (expected installed/web client_id and client_secret)")
	errMissingClientID         = errors.New("stored credentials.json is missing client_id/client_secret")
	errUnterminatedPlaceholder = errors.New("unterminated env placeholder")
	errUnsetEnvPlaceholder     = errors.New("environment variable is not set")
	errInvalidEnvPlaceholder   = errors.New("invalid env placeholder")
)

type ClientCredentials struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
}

type ParseGoogleOAuthClientJSONOptions struct {
	ExpandEnv bool
}

type googleCredentialsFile struct {
	Installed *struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	} `json:"installed"`
	Web *struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	} `json:"web"`
}

func ParseGoogleOAuthClientJSON(b []byte) (ClientCredentials, error) {
	return ParseGoogleOAuthClientJSONWithOptions(b, ParseGoogleOAuthClientJSONOptions{})
}

func ParseGoogleOAuthClientJSONWithOptions(b []byte, opts ParseGoogleOAuthClientJSONOptions) (ClientCredentials, error) {
	var f googleCredentialsFile
	if err := json.Unmarshal(b, &f); err != nil {
		return ClientCredentials{}, fmt.Errorf("decode credentials json: %w", err)
	}

	var clientID, clientSecret string
	if f.Installed != nil {
		clientID, clientSecret = f.Installed.ClientID, f.Installed.ClientSecret
	} else if f.Web != nil {
		clientID, clientSecret = f.Web.ClientID, f.Web.ClientSecret
	}

	if opts.ExpandEnv {
		var err error
		clientID, err = expandEnvPlaceholders(clientID)
		if err != nil {
			return ClientCredentials{}, fmt.Errorf("expand client_id: %w", err)
		}
		clientSecret, err = expandEnvPlaceholders(clientSecret)
		if err != nil {
			return ClientCredentials{}, fmt.Errorf("expand client_secret: %w", err)
		}
	}

	if clientID == "" || clientSecret == "" {
		return ClientCredentials{}, errInvalidCredentials
	}

	return ClientCredentials{ClientID: clientID, ClientSecret: clientSecret}, nil
}

func expandEnvPlaceholders(s string) (string, error) {
	var out strings.Builder
	for i := 0; i < len(s); {
		start := strings.Index(s[i:], "${")
		if start < 0 {
			out.WriteString(s[i:])
			break
		}
		start += i
		out.WriteString(s[i:start])
		end := strings.IndexByte(s[start+2:], '}')
		if end < 0 {
			return "", errUnterminatedPlaceholder
		}
		end += start + 2
		expr := s[start+2 : end]
		name, fallback, hasFallback, err := parseEnvPlaceholder(expr)
		if err != nil {
			return "", err
		}
		if value, ok := os.LookupEnv(name); ok {
			out.WriteString(value)
		} else if hasFallback {
			out.WriteString(fallback)
		} else {
			return "", fmt.Errorf("%w: %s", errUnsetEnvPlaceholder, name)
		}
		i = end + 1
	}
	return out.String(), nil
}

func parseEnvPlaceholder(expr string) (name string, fallback string, hasFallback bool, err error) {
	name = expr
	if before, after, ok := strings.Cut(expr, ":-"); ok {
		name = before
		fallback = after
		hasFallback = true
	}
	if !validEnvName(name) {
		return "", "", false, fmt.Errorf("%w: %q", errInvalidEnvPlaceholder, expr)
	}
	return name, fallback, hasFallback, nil
}

func validEnvName(name string) bool {
	if name == "" {
		return false
	}
	for i, r := range name {
		if r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (i > 0 && r >= '0' && r <= '9') {
			continue
		}
		return false
	}
	return true
}

type CredentialsMissingError struct {
	Path  string
	Cause error
}

func (e *CredentialsMissingError) Error() string {
	return "oauth credentials missing"
}

func (e *CredentialsMissingError) Unwrap() error {
	return e.Cause
}
