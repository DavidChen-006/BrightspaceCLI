package cmd

import (
	"testing"

	"google.golang.org/api/docs/v1"
)

func assertFencedCodeTextStyle(t *testing.T, got *docs.UpdateTextStyleRequest) {
	t.Helper()

	if got == nil {
		t.Fatal("missing fenced code text style request")
	}
	if got.Fields != "weightedFontFamily,foregroundColor" {
		t.Fatalf("fenced code fields = %q, want weightedFontFamily,foregroundColor", got.Fields)
	}

	style := got.TextStyle
	if style == nil {
		t.Fatal("missing fenced code text style")
	}
	if style.WeightedFontFamily == nil || style.WeightedFontFamily.FontFamily != "Roboto Mono" || style.WeightedFontFamily.Weight != 400 {
		t.Fatalf("unexpected fenced code font: %#v", style.WeightedFontFamily)
	}
	if style.ForegroundColor == nil || style.ForegroundColor.Color == nil || style.ForegroundColor.Color.RgbColor == nil {
		t.Fatalf("missing fenced code foreground color: %#v", style.ForegroundColor)
	}

	rgb := style.ForegroundColor.Color.RgbColor
	if rgb.Red != 0.09411764705882353 || rgb.Green != 0.5019607843137255 || rgb.Blue != 0.2196078431372549 {
		t.Fatalf("fenced code foreground = %#v, want #188038", rgb)
	}
}
