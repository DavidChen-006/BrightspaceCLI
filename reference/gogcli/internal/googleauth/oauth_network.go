package googleauth

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
)

var (
	errInvalidListenAddr     = errors.New("invalid listen address; use host or host:port")
	errNonLoopbackManageAddr = errors.New("accounts manager listen address must be loopback")
)

func normalizeListenAddr(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "127.0.0.1:0", nil
	}

	if _, _, err := net.SplitHostPort(raw); err == nil {
		return raw, nil
	}

	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		return raw + ":0", nil
	}

	if strings.Count(raw, ":") == 0 {
		return net.JoinHostPort(raw, "0"), nil
	}

	return "", fmt.Errorf("%w: %q", errInvalidListenAddr, raw)
}

func redirectURIFromListener(ln net.Listener) string {
	return listenerBaseURL(ln) + "/oauth2/callback"
}

func resolveServerRedirectURI(ln net.Listener, override string) string {
	if strings.TrimSpace(override) != "" {
		return strings.TrimSpace(override)
	}

	return redirectURIFromListener(ln)
}

func listenerBaseURL(ln net.Listener) string {
	addr := ln.Addr().(*net.TCPAddr)
	return "http://" + net.JoinHostPort(listenerURLHost(addr), strconv.Itoa(addr.Port))
}

func listenerURLHost(addr *net.TCPAddr) string {
	if addr == nil || addr.IP == nil || addr.IP.IsUnspecified() {
		return "127.0.0.1"
	}

	return addr.IP.String()
}

func validateManagementListenAddr(listenAddr string) error {
	host, _, err := net.SplitHostPort(listenAddr)
	if err != nil {
		return fmt.Errorf("%w: %q", errInvalidListenAddr, listenAddr)
	}

	if strings.EqualFold(host, "localhost") {
		return nil
	}

	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("%w: %s", errNonLoopbackManageAddr, listenAddr)
	}

	return nil
}
