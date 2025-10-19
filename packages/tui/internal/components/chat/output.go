package chat

import (
	"fmt"
	"strings"

	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/viewport"
)

// isExpandableOutput checks if output has ``` markers indicating code/diff content
func isExpandableOutput(output string) bool {
	trimmed := strings.TrimSpace(output)
	return strings.HasPrefix(trimmed, "```") && strings.HasSuffix(trimmed, "```")
}

// extractLanguageFromOutput extracts language hint from ```lang marker
// Returns empty string if no language specified
func extractLanguageFromOutput(output string) string {
	lines := strings.Split(output, "\n")
	if len(lines) == 0 {
		return ""
	}

	firstLine := strings.TrimSpace(lines[0])
	if !strings.HasPrefix(firstLine, "```") {
		return ""
	}

	// Extract language after ```
	lang := strings.TrimPrefix(firstLine, "```")
	lang = strings.TrimSpace(lang)

	// Return empty for generic ``` or diff
	if lang == "" || lang == "diff" {
		return lang
	}

	return lang
}

// renderUniversalOutput renders tool output with automatic expansion for code/diff
func renderUniversalOutput(
	output string,
	toolCall opencode.ToolPart,
	messageID string,
	partIndex int,
	width int,
	expandedContentBlocks map[string]bool,
	contentViewports map[string]*viewport.Model,
	screenHeight int,
) string {
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	// Check if output is expandable (has ``` markers)
	if isExpandableOutput(output) {
		// Universal expansion for code/diff outputs
		// Pass output WITH ``` markers - ToMarkdown needs them for syntax highlighting
		zoneID := fmt.Sprintf("output-%s-%d", messageID, partIndex)
		isExpanded := expandedContentBlocks != nil && expandedContentBlocks[zoneID]

		return renderExpandableContent(
			zoneID,
			output,
			width,
			"", // No language - let ToMarkdown parse it from ``` markers
			10, // truncHeight for collapsed state
			isExpanded,
			contentViewports,
			screenHeight,
		)
	}

	// Plain text output - use existing truncation
	defaultStyle := styles.NewStyle().Background(backgroundColor).Width(width - 6).Render
	return defaultStyle(output)
}
