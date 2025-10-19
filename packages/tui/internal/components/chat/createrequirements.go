package chat

import (
	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/util"
)

func createRequirementsSections(metadata CreateRequirementsMetadata, toolCall opencode.ToolPart, width int) []string {
	var sections []string
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	// Show the created content when running or completed
	newContent := metadata.NewShadowContent

	if newContent != "" && toolCall.State.Status != opencode.ToolPartStateStatusError {
		// Render as markdown
		rendered := util.ToMarkdown(newContent, width, backgroundColor)

		// Apply center truncation to show both start and end
		truncated := util.TruncateHeightCenter(rendered, 15)

		contentStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.Text()).
			Render(truncated)

		sections = append(sections, contentStyled)
	}

	// Show output message when completed
	if toolCall.State.Status == opencode.ToolPartStateStatusCompleted && toolCall.State.Output != "" {
		outputStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.Accent()).
			Render(toolCall.State.Output)
		sections = append(sections, outputStyled)
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
		errorStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(errorColor).
			Render(errorMessage)
		sections = append(sections, errorStyled)
	}

	return sections
}
