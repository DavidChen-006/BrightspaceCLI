package cmd

import "unicode/utf16"

func utf16Len(s string) int64 {
	return int64(len(utf16.Encode([]rune(s))))
}
