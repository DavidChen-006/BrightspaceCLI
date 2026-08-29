package cmd

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDestructiveConfirmationsHaveDryRunPath(t *testing.T) {
	allowedHelpers := map[string]bool{
		"confirmDestructive":          true,
		"dryRunAndConfirmDestructive": true,
		"driveBulkConfirm":            true,
	}

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}

	fset := token.NewFileSet()
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}

		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		file, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}

		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil || allowedHelpers[fn.Name.Name] {
				continue
			}
			hasConfirm := false
			hasDryRun := false
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				name, ok := call.Fun.(*ast.Ident)
				if !ok {
					return true
				}
				switch name.Name {
				case "confirmDestructiveChecked":
					hasConfirm = true
				case "dryRunExit", "dryRunAndConfirmDestructive":
					hasDryRun = true
				}
				return true
			})
			if hasConfirm && !hasDryRun {
				pos := fset.Position(fn.Pos())
				t.Fatalf("%s: %s calls confirmDestructiveChecked without dryRunExit", pos, fn.Name.Name)
			}
		}
	}
}
