package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var errIncompleteServiceAccountLayout = errors.New("incomplete service account layout")

type ServiceAccountFile struct {
	Path         string
	Data         []byte
	ModifiedAt   time.Time
	KeepSpecific bool
}

type ServiceAccountStore struct {
	layout Layout
}

func NewServiceAccountStore(layout Layout) *ServiceAccountStore {
	return &ServiceAccountStore{layout: layout}
}

func (s *ServiceAccountStore) Layout() Layout {
	if s == nil {
		return Layout{}
	}

	return s.layout
}

func (s *ServiceAccountStore) Path(email string) string {
	return s.layout.ServiceAccountPath(email)
}

func (s *ServiceAccountStore) KeepPath(email string) string {
	return s.layout.KeepServiceAccountPath(email)
}

func (s *ServiceAccountStore) Write(email string, data []byte) (string, error) {
	if err := s.validateLayout(false); err != nil {
		return "", err
	}

	if err := s.ensureDataDir(); err != nil {
		return "", err
	}

	path := s.Path(email)
	if err := WriteFileAtomic(path, data, 0o600); err != nil {
		return "", fmt.Errorf("write service account: %w", err)
	}

	return path, nil
}

func (s *ServiceAccountStore) WriteKeep(email string, data []byte) (string, error) {
	if err := s.validateLayout(false); err != nil {
		return "", err
	}

	if err := s.ensureDataDir(); err != nil {
		return "", err
	}

	path := s.KeepPath(email)
	if err := WriteFileAtomic(path, data, 0o600); err != nil {
		return "", fmt.Errorf("write Keep service account: %w", err)
	}

	return path, nil
}

func (s *ServiceAccountStore) WriteKeepCompatibility(email string, data []byte) ([]string, error) {
	keepPath, err := s.WriteKeep(email, data)
	if err != nil {
		return nil, err
	}

	genericPath, err := s.Write(email, data)
	if err != nil {
		return nil, err
	}

	return []string{keepPath, genericPath}, nil
}

func (s *ServiceAccountStore) Existing(email string, includeKeepFallback bool) (ServiceAccountFile, bool, error) {
	if err := s.validateLayout(true); err != nil {
		return ServiceAccountFile{}, false, err
	}

	candidates := s.candidates(email, includeKeepFallback)
	if len(candidates) == 0 {
		return ServiceAccountFile{}, false, nil
	}

	for _, candidate := range candidates {
		info, err := os.Stat(candidate.Path)
		if err == nil {
			candidate.ModifiedAt = info.ModTime()
			return candidate, true, nil
		}

		if !os.IsNotExist(err) {
			return ServiceAccountFile{}, false, fmt.Errorf("stat service account path: %w", err)
		}
	}

	return candidates[0], false, nil
}

func (s *ServiceAccountStore) Read(email string, includeKeepFallback bool) (ServiceAccountFile, bool, error) {
	file, exists, err := s.Existing(email, includeKeepFallback)
	if err != nil || !exists {
		return file, exists, err
	}

	data, err := os.ReadFile(file.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return ServiceAccountFile{
				Path:         file.Path,
				KeepSpecific: file.KeepSpecific,
			}, false, nil
		}

		return ServiceAccountFile{}, false, fmt.Errorf("read service account key: %w", err)
	}
	file.Data = data

	return file, true, nil
}

func (s *ServiceAccountStore) Remove(email string) (bool, error) {
	if err := s.validateLayout(true); err != nil {
		return false, err
	}

	candidates := s.candidates(email, true)
	removed := false

	for _, candidate := range candidates {
		if err := os.Remove(candidate.Path); err != nil {
			if os.IsNotExist(err) {
				continue
			}

			return removed, fmt.Errorf("remove service account file: %w", err)
		}
		removed = true
	}

	return removed, nil
}

func (s *ServiceAccountStore) ListEmails() ([]string, error) {
	if err := s.validateLayout(true); err != nil {
		return nil, err
	}

	out := make([]string, 0)
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

			return nil, fmt.Errorf("read service account dir: %w", err)
		}

		for _, entry := range entries {
			email := serviceAccountEmailFromEntry(entry)
			if email == "" {
				continue
			}

			if _, ok := seen[email]; ok {
				continue
			}
			seen[email] = struct{}{}
			out = append(out, email)
		}
	}

	sort.Strings(out)

	return out, nil
}

func (s *ServiceAccountStore) ensureDataDir() error {
	if err := os.MkdirAll(s.layout.DataDir, 0o700); err != nil {
		return fmt.Errorf("ensure data dir: %w", err)
	}

	return nil
}

func (s *ServiceAccountStore) validateLayout(includeLegacy bool) error {
	if s == nil || strings.TrimSpace(s.layout.DataDir) == "" {
		return fmt.Errorf("%w: data directory is required", errIncompleteServiceAccountLayout)
	}

	if includeLegacy && !s.layout.ExplicitData && strings.TrimSpace(s.layout.ConfigDir) == "" {
		return fmt.Errorf("%w: config directory is required when legacy lookup is enabled", errIncompleteServiceAccountLayout)
	}

	return nil
}

func (s *ServiceAccountStore) candidates(email string, includeKeepFallback bool) []ServiceAccountFile {
	candidates := []ServiceAccountFile{{Path: s.layout.ServiceAccountPath(email)}}
	if !s.layout.ExplicitData {
		candidates = append(candidates, ServiceAccountFile{Path: s.layout.ServiceAccountLegacyPath(email)})
	}

	if !includeKeepFallback {
		return uniqueServiceAccountFiles(candidates)
	}

	candidates = append(candidates, ServiceAccountFile{
		Path:         s.layout.KeepServiceAccountPath(email),
		KeepSpecific: true,
	})
	if !s.layout.ExplicitData {
		candidates = append(candidates, ServiceAccountFile{
			Path:         s.layout.KeepServiceAccountLegacySafePath(email),
			KeepSpecific: true,
		})
		if path, ok := s.rawKeepLegacyPath(email); ok {
			candidates = append(candidates, ServiceAccountFile{
				Path:         path,
				KeepSpecific: true,
			})
		}
	}

	return uniqueServiceAccountFiles(candidates)
}

func (s *ServiceAccountStore) rawKeepLegacyPath(email string) (string, bool) {
	if strings.ContainsAny(email, `/\`) {
		return "", false
	}

	path := filepath.Clean(s.layout.KeepServiceAccountLegacyPath(email))

	base := filepath.Base(path)
	if filepath.Dir(path) != filepath.Clean(s.layout.ConfigDir) ||
		!strings.HasPrefix(base, "keep-sa-") ||
		!strings.HasSuffix(base, ".json") {
		return "", false
	}

	return path, true
}

func uniqueServiceAccountFiles(files []ServiceAccountFile) []ServiceAccountFile {
	out := make([]ServiceAccountFile, 0, len(files))
	seen := make(map[string]struct{}, len(files))

	for _, file := range files {
		if file.Path == "" {
			continue
		}

		clean := filepath.Clean(file.Path)
		if _, ok := seen[clean]; ok {
			continue
		}
		seen[clean] = struct{}{}
		file.Path = clean
		out = append(out, file)
	}

	return out
}

func (l Layout) EnsureDataDir() (string, error) {
	if err := os.MkdirAll(l.DataDir, 0o700); err != nil {
		return "", fmt.Errorf("ensure data dir: %w", err)
	}

	return l.DataDir, nil
}

func serviceAccountEmailFromEntry(entry os.DirEntry) string {
	if entry.IsDir() {
		return ""
	}

	name := entry.Name()
	var encoded string

	switch {
	case strings.HasPrefix(name, "sa-") && strings.HasSuffix(name, ".json"):
		encoded = strings.TrimSuffix(strings.TrimPrefix(name, "sa-"), ".json")
	case strings.HasPrefix(name, "keep-sa-") && strings.HasSuffix(name, ".json"):
		encoded = strings.TrimSuffix(strings.TrimPrefix(name, "keep-sa-"), ".json")
	default:
		return ""
	}

	if decoded, err := base64.RawURLEncoding.DecodeString(encoded); err == nil {
		return strings.ToLower(strings.TrimSpace(string(decoded)))
	}

	if strings.HasPrefix(name, "keep-sa-") {
		return strings.ToLower(strings.TrimSpace(encoded))
	}

	return ""
}
