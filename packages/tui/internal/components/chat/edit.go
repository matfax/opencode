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
	"github.com/sst/opencode/internal/viewport"
)

func editSections(
	metadata EditMetadata,
	toolCall opencode.ToolPart,
	width int,
	filename string,
	expandedContentBlocks map[string]bool,
	contentViewports map[string]*viewport.Model,
	screenHeight int,
	messageID string,
	partIndex int,
) []string {
	diffContent := metadata.Diff
	var shadowDiffContent string
	if metadata.ShadowDiff != nil {
		shadowDiffContent = metadata.ShadowDiff.Diff
	}
	const previewLimit = 10

	// Build sections in exact order
	var sections []string
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	// Preview section - always show diff when available
	if diffContent != "" && toolCall.State.Status != opencode.ToolPartStateStatusError {
		// Check if fullContent is available for expandable rendering
		fullContent := metadata.FullContent
		hasFullContent := fullContent != ""

		if hasFullContent {
			// Use expandable pattern for diff content
			zoneID := fmt.Sprintf("edit-diff-%s-%d", messageID, partIndex)
			isExpanded := expandedContentBlocks[zoneID]

			// Format the full diff content
			var formattedDiff string
			if width < 120 {
				formattedDiff, _ = diff.FormatUnifiedDiff(
					filename,
					fullContent,
					diff.WithWidth(width-2),
				)
			} else {
				formattedDiff, _ = diff.FormatDiff(
					filename,
					fullContent,
					diff.WithWidth(width-2),
				)
			}

			// Render as expandable content (only the diff section is clickable)
			expandableContent := renderExpandableContent(
				zoneID,
				strings.TrimSpace(formattedDiff),
				width,
				"diff",
				previewLimit,
				isExpanded,
				contentViewports,
				screenHeight,
			)
			sections = append(sections, expandableContent)
		} else {
			// Fallback to original truncated rendering
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
			codeBlock := fmt.Sprintf("```diff\n%s\n```", strings.TrimSpace(formattedDiff))
			preview = util.ToMarkdown(codeBlock, width, backgroundColor)

			if previewLimit > 0 {
				preview = util.TruncateHeightCenter(preview, previewLimit)
			}

			if preview != "" {
				previewStyle := styles.NewStyle().
					Background(backgroundColor)
				sections = append(sections, previewStyle.Render(preview))
			}
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
		shadowCodeBlock := fmt.Sprintf("```diff\n%s\n```", strings.TrimSpace(formattedShadowDiff))
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
