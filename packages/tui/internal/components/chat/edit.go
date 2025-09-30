package chat

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/components/diff"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/util"
)

func editSections(metadata map[string]any, toolCall opencode.ToolPart, toolInputMap map[string]any, width int, filename string) []string {
	var diffContent string
	var statusMessage = "Starting edit operation"
	var format = "diff"
	var previewLimit = 10

	if val, ok := metadata["status"].(string); ok && val != "" {
		statusMessage = val
	}
	if val, ok := metadata["format"].(string); ok && val != "" {
		format = val
	}
	if val, ok := metadata["diff"].(string); ok {
		diffContent = val
	}
	if val, ok := metadata["previewLines"].(float64); ok && val > 0 {
		previewLimit = int(val)
	}

	// Build sections in exact order
	var sections []string
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	// 1. Status line: always show during running state
	if toolCall.State.Status == opencode.ToolPartStateStatusRunning {
		statusMessage = "🔄 " + statusMessage
		dots := (time.Now().Second() % 3) + 1
		statusMessage += strings.Repeat(".", dots)

		statusStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.Accent()).
			Bold(true).
			Render(statusMessage)
		sections = append(sections, statusStyled)
	}

	// 2. Instruction field with info symbol
	if instructions, ok := toolInputMap["instructions"].(string); ok && toolCall.State.Status == opencode.ToolPartStateStatusRunning {
		instrText := fmt.Sprintf("ℹ️ %s", instructions)
		instrWrapped := ansi.WordwrapWc(instrText, width-8, " ")
		instrStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.TextMuted()).
			Render(instrWrapped)
		sections = append(sections, instrStyled)
	}

	// 3. Preview section
	if diffContent != "" && toolCall.State.Status != opencode.ToolPartStateStatusError {
		var preview string
		if format == "diff" {
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
		} else {
			// Render snippet with simple code block
			codeBlock := fmt.Sprintf("```%s```", diffContent)
			preview = util.ToMarkdown(codeBlock, width, backgroundColor)
		}

		if previewLimit > 0 {
			preview = util.TruncateHeight(preview, previewLimit)
		}

		if preview != "" {
			previewStyle := styles.NewStyle().
				Background(backgroundColor)
			if format != "diff" {
				previewStyle = previewStyle.Padding(0, 2)
			}
			sections = append(sections, previewStyle.Render(preview))
		}
	}

	// 5. Summary field with success symbol
	if output := toolCall.State.Output; toolCall.State.Status == opencode.ToolPartStateStatusCompleted && output != "" {
		summaryWrapped := util.ToMarkdown(ansi.WordwrapWc(output, width-8, " "), width, backgroundColor)
		summaryStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.Accent()).
			Render(summaryWrapped)
		sections = append(sections, summaryStyled)
	}

	// 4. Error handling with warning symbol
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
		errorText := fmt.Sprintf("⚠️ %s", errorMessage)
		errorStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(errorColor).
			Render(errorText)
		sections = append(sections, errorStyled)
	}

	// 5. Add diagnostics if available
	if diagnostics := renderDiagnostics(metadata, filename, backgroundColor, width-6); diagnostics != "" {
		styledDiagnostics := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.TextMuted()).
			Render(diagnostics)
		sections = append(sections, styledDiagnostics)
	}

	return sections
}
