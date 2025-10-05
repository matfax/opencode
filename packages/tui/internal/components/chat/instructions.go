package chat

import (
	"fmt"

	"github.com/charmbracelet/x/ansi"
	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
)

// renderToolInstructions renders instruction/goal/description fields for running tools
// It checks common parameter names used by subagents: instructions, goal, description
func renderToolInstructions(toolInputMap map[string]any, toolCall opencode.ToolPart, width int) string {
	if toolCall.State.Status != opencode.ToolPartStateStatusRunning {
		return ""
	}

	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	// Check for common instruction field names in priority order
	var instructionText string

	if val, ok := toolInputMap["instructions"].(string); ok && val != "" {
		instructionText = val
	} else if val, ok := toolInputMap["goal"].(string); ok && val != "" {
		instructionText = val
	} else if val, ok := toolInputMap["description"].(string); ok && val != "" {
		instructionText = val
	}

	if instructionText == "" {
		return ""
	}

	// Format with appropriate icon and label based on field type
	prefix := "ℹ️ "

	formattedText := fmt.Sprintf("%s%s", prefix, instructionText)
	wrappedText := ansi.WordwrapWc(formattedText, width-8, " ")

	styledText := styles.NewStyle().
		Background(backgroundColor).
		Foreground(t.TextMuted()).
		Render(wrappedText)

	return styledText
}
