package termutil

import (
	"errors"
	"fmt"
	"os"
	"strconv"

	"golang.org/x/term"
)

var (
	errFDOverflow = errors.New("file descriptor overflows int")
	errNilFile    = errors.New("nil file")
)

func IntFD(fd uintptr) (int, error) {
	const maxInt32 = 1<<31 - 1
	if strconv.IntSize == 32 && fd > maxInt32 {
		return 0, fmt.Errorf("%w: %d", errFDOverflow, fd)
	}

	return int(fd), nil // #nosec G115 -- 32-bit overflow checked above; 64-bit int can represent uintptr file descriptors.
}

func IsTerminal(file *os.File) bool {
	fd, err := fileFD(file)
	return err == nil && term.IsTerminal(fd)
}

func ReadPassword(file *os.File) ([]byte, error) {
	fd, err := fileFD(file)
	if err != nil {
		return nil, err
	}

	password, err := term.ReadPassword(fd)
	if err != nil {
		return nil, fmt.Errorf("read terminal password: %w", err)
	}

	return password, nil
}

func GetSize(file *os.File) (int, int, error) {
	fd, err := fileFD(file)
	if err != nil {
		return 0, 0, err
	}

	width, height, err := term.GetSize(fd)
	if err != nil {
		return 0, 0, fmt.Errorf("get terminal size: %w", err)
	}

	return width, height, nil
}

func fileFD(file *os.File) (int, error) {
	if file == nil {
		return 0, errNilFile
	}

	return IntFD(file.Fd())
}
