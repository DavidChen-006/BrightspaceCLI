package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const AppName = "gogcli"

func uniquePaths(paths ...string) []string {
	out := make([]string, 0, len(paths))
	seen := make(map[string]struct{})

	for _, path := range paths {
		if path == "" {
			continue
		}

		clean := filepath.Clean(path)
		if _, ok := seen[clean]; ok {
			continue
		}
		seen[clean] = struct{}{}
		out = append(out, clean)
	}

	return out
}

// ExpandPath expands ~ at the beginning of a path to the user's home directory.
// This is needed because ~ is a shell feature and is not expanded when paths
// are quoted (e.g., --out "~/Downloads/file.pdf").
func ExpandPath(path string) (string, error) {
	if path == "" {
		return "", nil
	}

	if path == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("expand home dir: %w", err)
		}

		return home, nil
	}

	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, "~\\") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("expand home dir: %w", err)
		}

		return filepath.Join(home, strings.TrimLeft(path[2:], `/\`)), nil
	}

	return path, nil
}
