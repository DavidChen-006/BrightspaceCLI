package input

import (
	"bufio"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestReadLine(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr error
	}{
		{name: "with_newline", input: "hello\n", want: "hello"},
		{name: "without_newline", input: "hello", want: "hello"},
		{name: "with_crlf", input: "hello\r\n", want: "hello"},
		{name: "with_cr_only", input: "hello\r", want: "hello"},
		{name: "empty_eof", input: "", want: "", wantErr: io.EOF},
		{name: "only_newline", input: "\n", want: ""},
		{name: "only_crlf", input: "\r\n", want: ""},
		{name: "multiline_returns_first", input: "first\nsecond\n", want: "first"},
		{name: "url_without_newline", input: "http://localhost/?code=abc&state=xyz", want: "http://localhost/?code=abc&state=xyz"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ReadLine(strings.NewReader(tt.input))
			if tt.wantErr == nil && err != nil {
				t.Fatalf("ReadLine() error = %v, want nil", err)
			}

			if tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
				t.Fatalf("ReadLine() error = %v, want %v", err, tt.wantErr)
			}

			if got != tt.want {
				t.Fatalf("ReadLine() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestReadLineBareCRStreamingReaderReturnsPromptly(t *testing.T) {
	reader, writer := io.Pipe()

	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})

	done := make(chan struct {
		line string
		err  error
	}, 1)

	go func() {
		line, err := ReadLine(reader)
		done <- struct {
			line string
			err  error
		}{line: line, err: err}
	}()

	if _, err := writer.Write([]byte("hello\r")); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("ReadLine() error = %v, want nil", got.err)
		}

		if got.line != "hello" {
			t.Fatalf("ReadLine() = %q, want %q", got.line, "hello")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ReadLine blocked after bare carriage return")
	}
}

func TestReadLineBareCRWrappedStreamingReaderReturnsPromptly(t *testing.T) {
	reader, writer := io.Pipe()

	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})

	done := make(chan struct {
		line string
		err  error
	}, 1)

	go func() {
		line, err := ReadLine(wrappedReader{reader})
		done <- struct {
			line string
			err  error
		}{line: line, err: err}
	}()

	if _, err := writer.Write([]byte("hello\r")); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("ReadLine() error = %v, want nil", got.err)
		}

		if got.line != "hello" {
			t.Fatalf("ReadLine() = %q, want %q", got.line, "hello")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ReadLine blocked after bare carriage return")
	}
}

func TestReadLineInterfaceWrappedNonComparableReaderDoesNotPanic(t *testing.T) {
	line, err := ReadLine(wrappedReader{nonComparableReader{data: []byte("hello\nignored")}})
	if err != nil {
		t.Fatalf("ReadLine() error = %v, want nil", err)
	}

	if line != "hello" {
		t.Fatalf("ReadLine() = %q, want hello", line)
	}
}

func TestReadLineBareCRBufferedStreamingReaderReturnsPromptly(t *testing.T) {
	reader, writer := io.Pipe()

	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})

	done := make(chan struct {
		line string
		err  error
	}, 1)

	go func() {
		line, err := ReadLine(bufio.NewReader(reader))
		done <- struct {
			line string
			err  error
		}{line: line, err: err}
	}()

	if _, err := writer.Write([]byte("hello\r")); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("ReadLine() error = %v, want nil", got.err)
		}

		if got.line != "hello" {
			t.Fatalf("ReadLine() = %q, want %q", got.line, "hello")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ReadLine blocked after bare carriage return")
	}
}

func TestReadLineConsumesCRLFFromPipeWrite(t *testing.T) {
	reader, writer := io.Pipe()

	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})

	done := make(chan error, 1)

	go func() {
		_, err := writer.Write([]byte("first\r\nsecond\n"))
		done <- err
	}()

	first, err := ReadLine(reader)
	if err != nil {
		t.Fatalf("ReadLine first: %v", err)
	}

	second, err := ReadLine(reader)
	if err != nil {
		t.Fatalf("ReadLine second: %v", err)
	}

	if first != "first" || second != "second" {
		t.Fatalf("lines = %q, %q; want first, second", first, second)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("write: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pipe writer blocked")
	}
}

func TestReadLineDoesNotDiscardRemainingBytes(t *testing.T) {
	r := strings.NewReader("first\nsecond\n")

	line, err := ReadLine(r)
	if err != nil {
		t.Fatalf("ReadLine: %v", err)
	}

	if line != "first" {
		t.Fatalf("line = %q, want first", line)
	}

	rest, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}

	if string(rest) != "second\n" {
		t.Fatalf("remaining bytes = %q, want second line", rest)
	}
}

func TestReadLineConsumesCRLFWithoutDiscardingNextLine(t *testing.T) {
	r := strings.NewReader("first\r\nsecond\n")

	line, err := ReadLine(r)
	if err != nil {
		t.Fatalf("ReadLine: %v", err)
	}

	if line != "first" {
		t.Fatalf("line = %q, want first", line)
	}

	rest, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}

	if string(rest) != "second\n" {
		t.Fatalf("remaining bytes = %q, want second line", rest)
	}
}

func TestReadLineConsumesCRLFOnPlainReader(t *testing.T) {
	r := &plainByteReader{data: []byte("first\r\nsecond\n")}

	first, err := ReadLine(r)
	if err != nil {
		t.Fatalf("ReadLine first: %v", err)
	}

	second, err := ReadLine(r)
	if err != nil {
		t.Fatalf("ReadLine second: %v", err)
	}

	if first != "first" || second != "second" {
		t.Fatalf("lines = %q, %q; want first, second", first, second)
	}
}

func TestReadLineBareCROnPlainReaderPreservesNextByte(t *testing.T) {
	r := &plainByteReader{data: []byte("first\rsecond\n")}

	first, err := ReadLine(r)
	if err != nil {
		t.Fatalf("ReadLine first: %v", err)
	}

	second, err := ReadLine(r)
	if err != nil {
		t.Fatalf("ReadLine second: %v", err)
	}

	if first != "first" || second != "second" {
		t.Fatalf("lines = %q, %q; want first, second", first, second)
	}
}

func TestReadLineBareCRPreservesNextByteWhenUnreadable(t *testing.T) {
	r := strings.NewReader("first\rsecond\n")

	line, err := ReadLine(r)
	if err != nil {
		t.Fatalf("ReadLine: %v", err)
	}

	if line != "first" {
		t.Fatalf("line = %q, want first", line)
	}

	rest, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}

	if string(rest) != "second\n" {
		t.Fatalf("remaining bytes = %q, want second line", rest)
	}
}

func TestReadLineProcessesByteReturnedWithEOF(t *testing.T) {
	line, err := ReadLine(&eofByteReader{b: 'x'})
	if err != nil {
		t.Fatalf("ReadLine: %v", err)
	}

	if line != "x" {
		t.Fatalf("line = %q, want x", line)
	}
}

type eofByteReader struct {
	b    byte
	read bool
}

func (r *eofByteReader) Read(p []byte) (int, error) {
	if r.read {
		return 0, io.EOF
	}
	r.read = true
	p[0] = r.b

	return 1, io.EOF
}

type plainByteReader struct {
	data []byte
	pos  int
}

func (r *plainByteReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}

	p[0] = r.data[r.pos]
	r.pos++

	return 1, nil
}

func (r *plainByteReader) Len() int {
	return len(r.data) - r.pos
}

type wrappedReader struct {
	io.Reader
}

type nonComparableReader struct {
	data []byte
}

func (r nonComparableReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}

	n := copy(p, r.data)

	return n, io.EOF
}
