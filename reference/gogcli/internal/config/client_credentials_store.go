package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type ClientCredentialsStore struct {
	layout Layout
}

func NewClientCredentialsStore(layout Layout) *ClientCredentialsStore {
	return &ClientCredentialsStore{layout: layout}
}

func (s *ClientCredentialsStore) PathFor(client string) (string, error) {
	return s.layout.ClientCredentialsPathFor(client)
}

func (s *ClientCredentialsStore) legacyPathFor(client string) (string, error) {
	return s.layout.LegacyClientCredentialsPathFor(client)
}

func (s *ClientCredentialsStore) ensureDataDir() error {
	if err := os.MkdirAll(s.layout.DataDir, 0o700); err != nil {
		return fmt.Errorf("ensure data dir: %w", err)
	}

	return nil
}

func (s *ClientCredentialsStore) Write(client string, credentials ClientCredentials) error {
	if err := s.ensureDataDir(); err != nil {
		return err
	}

	path, err := s.PathFor(client)
	if err != nil {
		return fmt.Errorf("resolve credentials path: %w", err)
	}

	data, err := json.MarshalIndent(credentials, "", "  ") //nolint:gosec // required OAuth client credentials payload
	if err != nil {
		return fmt.Errorf("encode credentials json: %w", err)
	}

	data = append(data, '\n')

	if err := WriteFileAtomic(path, data, 0o600); err != nil {
		return fmt.Errorf("write credentials: %w", err)
	}

	return nil
}

func (s *ClientCredentialsStore) WriteMetadata(client string, credentials ClientCredentials) error {
	if err := s.ensureDataDir(); err != nil {
		return err
	}

	path, err := s.PathFor(client)
	if err != nil {
		return fmt.Errorf("resolve credentials path: %w", err)
	}

	metadata := struct {
		ClientID string `json:"client_id"`
	}{
		ClientID: credentials.ClientID,
	}

	data, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return fmt.Errorf("encode credentials metadata: %w", err)
	}

	data = append(data, '\n')

	if err := WriteFileAtomic(path, data, 0o600); err != nil {
		return fmt.Errorf("write credentials metadata: %w", err)
	}

	return nil
}

func (s *ClientCredentialsStore) Read(client string) (ClientCredentials, error) {
	credentials, err := s.ReadMetadata(client)
	if err != nil {
		return ClientCredentials{}, err
	}

	if credentials.ClientSecret == "" {
		return ClientCredentials{}, errMissingClientID
	}

	return credentials, nil
}

func (s *ClientCredentialsStore) ReadMetadata(client string) (ClientCredentials, error) {
	path, err := s.PathFor(client)
	if err != nil {
		return ClientCredentials{}, fmt.Errorf("resolve credentials path: %w", err)
	}

	data, err := os.ReadFile(path) //nolint:gosec // path is derived from configured data dir
	if err != nil && os.IsNotExist(err) && !s.layout.ExplicitData {
		legacyPath, legacyErr := s.legacyPathFor(client)
		if legacyErr != nil {
			return ClientCredentials{}, fmt.Errorf("resolve legacy credentials path: %w", legacyErr)
		}

		data, err = os.ReadFile(legacyPath) //nolint:gosec // path is derived from configured legacy dir
	}

	if err != nil {
		if os.IsNotExist(err) {
			return ClientCredentials{}, &CredentialsMissingError{Path: path, Cause: err}
		}

		return ClientCredentials{}, fmt.Errorf("read credentials: %w", err)
	}

	var credentials ClientCredentials
	if err := json.Unmarshal(data, &credentials); err != nil {
		return ClientCredentials{}, fmt.Errorf("decode credentials: %w", err)
	}

	if credentials.ClientID == "" {
		return ClientCredentials{}, errMissingClientID
	}

	return credentials, nil
}

func (s *ClientCredentialsStore) Delete(client string) error {
	path, err := s.PathFor(client)
	if err != nil {
		return fmt.Errorf("resolve credentials path: %w", err)
	}

	candidates := []string{path}

	if !s.layout.ExplicitData {
		legacyPath, legacyErr := s.legacyPathFor(client)
		if legacyErr != nil {
			return fmt.Errorf("resolve legacy credentials path: %w", legacyErr)
		}

		candidates = append(candidates, legacyPath)
	}

	removed := false

	for _, candidate := range uniquePaths(candidates...) {
		if err := os.Remove(candidate); err != nil {
			if os.IsNotExist(err) {
				continue
			}

			return fmt.Errorf("delete credentials: %w", err)
		}
		removed = true
	}

	if !removed {
		return &CredentialsMissingError{Path: path, Cause: os.ErrNotExist}
	}

	return nil
}

func (s *ClientCredentialsStore) ExistingPath(client string) (string, bool, error) {
	path, err := s.PathFor(client)
	if err != nil {
		return "", false, err
	}

	if _, statErr := os.Stat(path); statErr == nil {
		return path, true, nil
	} else if !os.IsNotExist(statErr) {
		return "", false, fmt.Errorf("stat credentials: %w", statErr)
	}

	if s.layout.ExplicitData {
		return path, false, nil
	}

	legacyPath, err := s.legacyPathFor(client)
	if err != nil {
		return "", false, err
	}

	if legacyPath == path {
		return path, false, nil
	}

	if _, err := os.Stat(legacyPath); err != nil {
		if os.IsNotExist(err) {
			return path, false, nil
		}

		return "", false, fmt.Errorf("stat legacy credentials: %w", err)
	}

	return legacyPath, true, nil
}

func (s *ClientCredentialsStore) List() ([]ClientCredentialsInfo, error) {
	out := make([]ClientCredentialsInfo, 0)
	seen := make(map[string]struct{})

	dirs := []string{s.layout.DataDir}
	if !s.layout.ExplicitData {
		dirs = append(dirs, s.layout.ConfigDir)
	}

	for _, dir := range uniquePaths(dirs...) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}

			return nil, fmt.Errorf("read credentials dir: %w", err)
		}

		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}

			name := entry.Name()
			switch {
			case name == "credentials.json":
				if _, ok := seen[DefaultClientName]; ok {
					continue
				}
				seen[DefaultClientName] = struct{}{}
				out = append(out, ClientCredentialsInfo{
					Client:  DefaultClientName,
					Path:    filepath.Join(dir, name),
					Default: true,
				})
			case strings.HasPrefix(name, "credentials-") && strings.HasSuffix(name, ".json"):
				raw := strings.TrimSuffix(strings.TrimPrefix(name, "credentials-"), ".json")

				client, err := NormalizeClientName(raw)
				if err != nil {
					continue
				}

				if _, ok := seen[client]; ok {
					continue
				}
				seen[client] = struct{}{}
				out = append(out, ClientCredentialsInfo{
					Client: client,
					Path:   filepath.Join(dir, name),
				})
			}
		}
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Client < out[j].Client })

	return out, nil
}
