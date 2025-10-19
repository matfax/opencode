package chat

import (
	"github.com/charmbracelet/x/ansi"
	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/util"
)

func reviewSections(metadata ReviewMetadata, toolCall opencode.ToolPart, width int) []string {
	var sections []string
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	// Show result when completed
	if toolCall.State.Status == opencode.ToolPartStateStatusCompleted && toolCall.State.Output != "" {
		// Parse the output into summary and suggestions
		output := toolCall.State.Output

		// Check if review passed or failed from metadata
		passed := metadata.Passed

		// Format the review result as markdown
		var resultText string
		if passed {
			resultText = "✅ **Review Passed**\n\n" + output
		} else {
			resultText = "❌ **Review Failed**\n\n" + output
		}

		// Render as markdown
		rendered := util.ToMarkdown(resultText, width, backgroundColor)

		// Style based on pass/fail
		var resultColor = t.Success()
		if !passed {
			resultColor = t.Error()
		}

		styledResult := styles.NewStyle().
			Background(backgroundColor).
			Foreground(resultColor).
			Render(rendered)

		sections = append(sections, styledResult)
	}

	// Error handling
	hasError := false
	var errorMessage string
	var errorColor = t.Error()
	if toolCall.State.Status == opencode.ToolPartStateStatusError {
		hasError = true
		errorMessage = toolCall.State.Error
	} else if toolCall.State.Status == opencode.ToolPartStateStatusRunning && metadata.Error != "" {
		hasError = true
		errorMessage = metadata.Error
		errorColor = t.Warning()
	}
	if hasError && errorMessage != "" {
		wrappedError := ansi.WordwrapWc(errorMessage, width-8, " ")
		errorStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(errorColor).
			Render(wrappedError)
		sections = append(sections, errorStyled)
	}

	return sections
}
