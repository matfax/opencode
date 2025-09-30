package chat

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss/v2/compat"
	"github.com/charmbracelet/x/ansi"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
)

// Diagnostic represents an LSP diagnostic
type Diagnostic struct {
	Range struct {
		Start struct {
			Line      int `json:"line"`
			Character int `json:"character"`
		} `json:"start"`
	} `json:"range"`
	Severity int    `json:"severity"`
	Message  string `json:"message"`
}

// renderDiagnostics formats LSP diagnostics for display in the TUI
func renderDiagnostics(
	metadata map[string]any,
	filePath string,
	backgroundColor compat.AdaptiveColor,
	width int,
) string {
	if diagnosticsData, ok := metadata["diagnostics"].(map[string]any); ok {
		if fileDiagnostics, ok := diagnosticsData[filePath].([]any); ok {
			var errorDiagnostics []string
			for _, diagInterface := range fileDiagnostics {
				diagMap, ok := diagInterface.(map[string]any)
				if !ok {
					continue
				}
				// Parse the diagnostic
				var diag Diagnostic
				diagBytes, err := json.Marshal(diagMap)
				if err != nil {
					continue
				}
				if err := json.Unmarshal(diagBytes, &diag); err != nil {
					continue
				}
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
	}
	return ""

	// diagnosticsData should be a map[string][]Diagnostic
	// strDiagnosticsData := diagnosticsData.Raw()
	// diagnosticsMap := gjson.Parse(strDiagnosticsData).Value().(map[string]any)
	// fileDiagnostics, ok := diagnosticsMap[filePath]
	// if !ok {
	// 	return ""
	// }

	// diagnosticsList, ok := fileDiagnostics.([]any)
	// if !ok {
	// 	return ""
	// }

}
