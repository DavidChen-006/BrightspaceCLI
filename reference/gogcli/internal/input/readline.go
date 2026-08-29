package input

import (
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync"
)

// ReadLine reads a single line from r.
//
// It supports Unix (\n) and Windows (\r\n) line endings, and treats a bare \r as
// end-of-line as well.
//
// If the input ends with EOF before a newline and there is buffered content, the
// accumulated content is returned with a nil error.
//
// If EOF is encountered without any buffered content, ReadLine returns io.EOF.
func ReadLine(r io.Reader) (string, error) {
	if br, ok := r.(byteUnreadReader); ok {
		return readLineByteReader(br)
	}

	return readLineReader(r)
}

func readLineReader(r io.Reader) (string, error) {
	var sb strings.Builder
	var buf [4096]byte

	for {
		if pending, ok := takePendingBytes(r); ok {
			if line, done, chunkErr := appendLineChunk(&sb, pending, r); chunkErr != nil {
				return "", chunkErr
			} else if done {
				return line, nil
			}
		}

		n, err := r.Read(buf[:])
		if err == nil {
			if n > 0 {
				if line, done, chunkErr := appendLineChunk(&sb, buf[:n], r); chunkErr != nil {
					return "", chunkErr
				} else if done {
					return line, nil
				}
			}

			continue
		}

		if n > 0 {
			if line, done, chunkErr := appendLineChunk(&sb, buf[:n], r); chunkErr != nil {
				return "", chunkErr
			} else if done {
				return line, nil
			}
		}

		if errors.Is(err, io.EOF) {
			if sb.Len() > 0 {
				return sb.String(), nil
			}

			return "", io.EOF
		}

		return sb.String(), fmt.Errorf("read line: %w", err)
	}
}

var pendingLineBytes sync.Map

type byteUnreadReader interface {
	ReadByte() (byte, error)
	UnreadByte() error
}

type bufferedReader interface {
	Buffered() int
}

func appendLineChunk(sb *strings.Builder, chunk []byte, r io.Reader) (string, bool, error) {
	for i, b := range chunk {
		if b != '\n' && b != '\r' {
			_ = sb.WriteByte(b)
			continue
		}

		restStart := i + 1
		if b == '\r' && restStart < len(chunk) && chunk[restStart] == '\n' {
			restStart++
		} else if b == '\r' && restStart == len(chunk) {
			if err := consumeTrailingCRLookahead(r); err != nil {
				return "", false, err
			}
		}

		rememberPendingBytes(r, chunk[restStart:])

		return sb.String(), true, nil
	}

	return "", false, nil
}

type lenReader interface {
	Len() int
}

func consumeTrailingCRLookahead(r io.Reader) error {
	lr, ok := r.(lenReader)
	if !ok || lr.Len() == 0 {
		return nil
	}

	var one [1]byte

	n, err := r.Read(one[:])
	if n > 0 && one[0] != '\n' {
		rememberPendingBytes(r, one[:1])
	}

	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("read line: %w", err)
	}

	return nil
}

func takePendingBytes(r io.Reader) ([]byte, bool) {
	key, ok := pendingByteKey(r)
	if !ok {
		return nil, false
	}

	v, ok := pendingLineBytes.LoadAndDelete(key)
	if !ok {
		return nil, false
	}

	b, ok := v.([]byte)

	return b, ok
}

func rememberPendingBytes(r io.Reader, b []byte) {
	if len(b) == 0 {
		return
	}

	key, ok := pendingByteKey(r)
	if !ok {
		return
	}

	pendingLineBytes.Store(key, append([]byte(nil), b...))
}

func pendingByteKey(r io.Reader) (any, bool) {
	if r == nil {
		return nil, false
	}

	v := reflect.ValueOf(r)
	if !v.IsValid() || !v.Comparable() {
		return nil, false
	}

	return r, true
}

func readLineByteReader(r byteUnreadReader) (string, error) {
	var sb strings.Builder

	for {
		b, err := r.ReadByte()
		if err != nil {
			if errors.Is(err, io.EOF) {
				if sb.Len() > 0 {
					return sb.String(), nil
				}

				return "", io.EOF
			}

			return "", fmt.Errorf("read line: %w", err)
		}

		if b == '\n' {
			return sb.String(), nil
		}

		if b == '\r' {
			if buffered, ok := r.(bufferedReader); ok && buffered.Buffered() == 0 {
				return sb.String(), nil
			}

			next, err := r.ReadByte()
			if err == nil && next != '\n' {
				if unreadErr := r.UnreadByte(); unreadErr != nil {
					return "", fmt.Errorf("unread byte after carriage return: %w", unreadErr)
				}
			} else if err != nil && !errors.Is(err, io.EOF) {
				return "", fmt.Errorf("read line: %w", err)
			}

			return sb.String(), nil
		}

		sb.WriteByte(b)
	}
}
