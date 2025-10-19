package chat

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss/v2/compat"
	"github.com/charmbracelet/x/ansi"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
)

// renderDiagnostics formats LSP diagnostics for display in the TUI
func renderDiagnostics(
	diagnostics Diagnostics,
	filePath string,
	backgroundColor compat.AdaptiveColor,
	width int,
) string {
	fileDiagnostics, ok := diagnostics[filePath]
	if !ok {
		return ""
	}

	var errorDiagnostics []string
	for _, diag := range fileDiagnostics {
		// Only show error diagnostics (severity === 1)
		if diag.Severity != 1 {
			continue
		}
		line := diag.Range.Start.Line + 1        // 1-based
		column := diag.Range.Start.Character + 1 // 1-based
		errorDiagnostics = append(
			errorDiagnostics,
			fmt.Sprintf("Error [%d:%d] %s", line, column, diag.Message),
		)
	}
	if len(errorDiagnostics) == 0 {
		return ""
	}

	t := theme.CurrentTheme()
	var result strings.Builder
	for _, diagnostic := range errorDiagnostics {
		if result.Len() > 0 {
			result.WriteString("\n\n")
		}
		diagnostic = ansi.WordwrapWc(diagnostic, width, " -")
		result.WriteString(
			styles.NewStyle().
				Background(backgroundColor).
				Foreground(t.Error()).
				Render(diagnostic),
		)
	}
	return result.String()
}
