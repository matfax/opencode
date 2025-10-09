package chat

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/components/diff"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/util"
)

func editSections(metadata map[string]any, toolCall opencode.ToolPart, width int, filename string) []string {
	var diffContent string
	var shadowDiffContent string
	var previewLimit = 10

	if val, ok := metadata["diff"].(string); ok {
		diffContent = val
	}
	if val, ok := metadata["shadowDiff"].(string); ok {
		shadowDiffContent = val
	}
	if val, ok := metadata["previewLines"].(float64); ok && val > 0 {
		previewLimit = int(val)
	}

	// Build sections in exact order
	var sections []string
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	// Preview section - always show diff when available
	if diffContent != "" && toolCall.State.Status != opencode.ToolPartStateStatusError {
		var preview string
		// Always render as diff, regardless of format
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
		codeBlock := fmt.Sprintf("```diff\n%s```", strings.TrimSpace(formattedDiff))
		preview = util.ToMarkdown(codeBlock, width, backgroundColor)

		if previewLimit > 0 {
			preview = util.TruncateHeight(preview, previewLimit)
		}

		if preview != "" {
			previewStyle := styles.NewStyle().
				Background(backgroundColor)
			sections = append(sections, previewStyle.Render(preview))
		}
	}

	// Shadow diff section - show requirements changes when available
	if shadowDiffContent != "" && toolCall.State.Status != opencode.ToolPartStateStatusError {
		// Derive shadow filename from source filename
		shadowFilename := strings.TrimSuffix(filename, filepath.Ext(filename)) + ".md"

		// Always use unified diff format for shadow files
		formattedShadowDiff, _ := diff.FormatUnifiedDiff(
			shadowFilename,
			shadowDiffContent,
			diff.WithWidth(width-2),
		)

		shadowHeader := "📋 Requirements Changes:"
		shadowCodeBlock := fmt.Sprintf("```diff\n%s```", strings.TrimSpace(formattedShadowDiff))
		shadowPreview := util.ToMarkdown(shadowHeader+"\n"+shadowCodeBlock, width, backgroundColor)

		if shadowPreview != "" {
			shadowStyle := styles.NewStyle().
				Background(backgroundColor).
				Foreground(t.TextMuted())
			sections = append(sections, shadowStyle.Render(shadowPreview))
		}
	}

	// Summary field with success symbol
	if output := toolCall.State.Output; toolCall.State.Status == opencode.ToolPartStateStatusCompleted && output != "" {
		summaryWrapped := util.ToMarkdown(ansi.WordwrapWc(output, width-8, " "), width, backgroundColor)
		summaryStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.Accent()).
			Render(summaryWrapped)
		sections = append(sections, summaryStyled)
	}

	// Error handling with warning symbol
	hasError := false
	var errorMessage string
	var errorColor = t.Error()
	if toolCall.State.Status == opencode.ToolPartStateStatusError {
		hasError = true
		errorMessage = toolCall.State.Error
	} else if toolCall.State.Status == opencode.ToolPartStateStatusRunning && metadata != nil {
		if err, ok := metadata["error"].(string); ok && err != "" {
			hasError = true
			errorMessage = err
			errorColor = t.Warning()
		}
	}
	if hasError && errorMessage != "" {
		errorStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(errorColor).
			Render(errorMessage)
		sections = append(sections, errorStyled)
	}

	// Add diagnostics if available
	if diagnostics := renderDiagnostics(metadata, filename, backgroundColor, width-6); diagnostics != "" && diagnostics != errorMessage {
		styledDiagnostics := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.TextMuted()).
			Render(diagnostics)
		sections = append(sections, styledDiagnostics)
	}

	return sections
}
