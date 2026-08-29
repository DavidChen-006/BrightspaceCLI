package docsmarkdown

import (
	"testing"
	"time"
)

func withTimeout(t *testing.T, d time.Duration, name string, fn func()) {
	t.Helper()

	done := make(chan struct{})

	go func() {
		defer close(done)

		fn()
	}()

	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("%s: timed out after %s (suspected infinite loop)", name, d)
	}
}

func TestNextRune_SingleMultiByteRune(t *testing.T) {
	cases := []struct {
		name     string
		in       string
		wantStr  string
		wantSize int
	}{
		{name: "empty", in: "", wantStr: "", wantSize: 0},
		{name: "single ascii", in: "a", wantStr: "a", wantSize: 1},
		{name: "two ascii", in: "ab", wantStr: "a", wantSize: 1},
		{name: "single thai (3 bytes)", in: "ก", wantStr: "ก", wantSize: 3},
		{name: "single emoji (4 bytes)", in: "😀", wantStr: "😀", wantSize: 4},
		{name: "two thai", in: "กข", wantStr: "ก", wantSize: 3},
		{name: "thai then ascii", in: "กa", wantStr: "ก", wantSize: 3},
		{name: "ascii then thai", in: "aก", wantStr: "a", wantSize: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotStr, gotSize := nextRune(tc.in)
			if gotStr != tc.wantStr || gotSize != tc.wantSize {
				t.Fatalf("nextRune(%q) = (%q, %d), want (%q, %d)",
					tc.in, gotStr, gotSize, tc.wantStr, tc.wantSize)
			}
		})
	}
}

func TestParseInlineFormatting_Thai(t *testing.T) {
	inputs := []string{
		"ก",
		"ส่วนคำถาม",
		"คำถามที่พบบ่อย",
		"**ตัวหนา** ปกติ *เอียง* `code`",
		"พิมพ์ภาษาไทย 😀",
	}
	for _, input := range inputs {
		t.Run(input, func(t *testing.T) {
			withTimeout(t, 2*time.Second, "ParseInlineFormatting", func() {
				_, stripped := ParseInlineFormatting(input)
				if stripped == "" {
					t.Fatalf("ParseInlineFormatting(%q) returned empty stripped text", input)
				}
			})
		})
	}
}

func TestMarkdownToDocsRequests_ThaiAppend(t *testing.T) {
	const sample = `## ส่วนคำถาม

คำถามที่พบบ่อยของลูกค้า

- ราคาเท่าไหร่
- ส่งของเมื่อไหร่

> ติดต่อสอบถามเพิ่มเติม
`

	withTimeout(t, 5*time.Second, "MarkdownToDocsRequests", func() {
		elements := ParseMarkdown(sample)
		if len(elements) == 0 {
			t.Fatal("ParseMarkdown returned no elements for Thai sample")
		}

		reqs, plain, _ := MarkdownToDocsRequests(elements, 100, "")
		if plain == "" {
			t.Fatal("MarkdownToDocsRequests returned empty plain text for Thai sample")
		}

		if len(reqs) == 0 {
			t.Fatal("MarkdownToDocsRequests returned no requests for Thai sample")
		}
	})
}
