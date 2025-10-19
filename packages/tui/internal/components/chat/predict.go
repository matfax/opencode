package chat

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/components/diff"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/util"
)

func predictSections(metadata PredictMetadata, toolCall opencode.ToolPart, width int, filename string) []string {
	diffContent := metadata.Diff
	format := metadata.Format
	previewLimit := 10
	if metadata.PreviewLines > 0 {
		previewLimit = metadata.PreviewLines
	}

	// Build sections in exact order
	var sections []string
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	// Preview section - show predicted diff or snippet when available
	if diffContent != "" && toolCall.State.Status != opencode.ToolPartStateStatusError {
		var preview string

		// Check if this is a snippet or diff format
		if format == "Snippet" {
			// Render as regular code with syntax highlighting
			preview = util.RenderFile(filename, diffContent, width, util.WithTruncate(20))
		} else {
			// Render as diff with syntax highlighting
			var formattedDiff string
			if width < 120 {
				formattedDiff, _ = diff.FormatUnifiedDiff(
					filename,
					diffContent,
					diff.WithWidth(width-2),
				)
			} else {
				formattedDiff, _ = diff.FormatDiff(
					filename,
					diffContent,
					diff.WithWidth(width-2),
				)
			}
			codeBlock := fmt.Sprintf("```diff\n%s\n```", strings.TrimSpace(formattedDiff))
			preview = util.ToMarkdown(codeBlock, width, backgroundColor)
		}

		if previewLimit > 0 {
			preview = util.TruncateHeightCenter(preview, previewLimit)
		}

		if preview != "" {
			previewStyle := styles.NewStyle().
				Background(backgroundColor)
			sections = append(sections, previewStyle.Render(preview))
		}
	}

	// Success message
	if output := toolCall.State.Output; toolCall.State.Status == opencode.ToolPartStateStatusCompleted && output != "" {
		summaryWrapped := util.ToMarkdown(ansi.WordwrapWc(output, width-8, " "), width, backgroundColor)
		summaryStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.Accent()).
			Render(summaryWrapped)
		sections = append(sections, summaryStyled)
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

	// Add diagnostics if available
	if diagnostics := renderDiagnostics(metadata.Diagnostics, filename, backgroundColor, width-6); diagnostics != "" && diagnostics != errorMessage {
		styledDiagnostics := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.TextMuted()).
			Render(diagnostics)
		sections = append(sections, styledDiagnostics)
	}

	return sections
}
