package chat

import (
	"fmt"

	"github.com/charmbracelet/lipgloss/v2"
	zone "github.com/lrstanley/bubblezone/v2"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/util"
	"github.com/sst/opencode/internal/viewport"
)

// renderExpandableContent creates an expandable/collapsible content block
// with center-truncation when collapsed and full scrollable viewport when expanded.
//
// Parameters:
//   - zoneID: Unique identifier for this expandable block (used for click detection)
//   - fullContent: Complete content to display (no truncation)
//   - width: Width available for rendering
//   - language: Syntax highlighting language (e.g., "go", "typescript", "")
//   - truncHeight: Number of lines to show when collapsed (using center-concat)
//   - isExpanded: Whether this block is currently expanded
//   - expandedViewports: Map of zone IDs to viewport models
//   - screenHeight: Total screen height for calculating max viewport height
//
// Returns rendered content with zone marker for click detection
func renderExpandableContent(
	zoneID string,
	fullContent string,
	width int,
	language string,
	truncHeight int,
	isExpanded bool,
	expandedViewports map[string]*viewport.Model,
	screenHeight int,
) string {
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	if isExpanded {
		// Expanded state: Show full content in scrollable viewport with border
		var vp *viewport.Model
		if expandedViewports != nil && expandedViewports[zoneID] != nil {
			vp = expandedViewports[zoneID]

			// Update viewport with fresh content and auto-scroll if needed
			oldContent := vp.GetContent()
			if oldContent != fullContent {
				// Content has changed, check if we should auto-scroll
				wasAtBottom := vp.AtBottom()

				// Wrap content in code block with syntax highlighting
				wrappedContent := fullContent
				if language != "" {
					wrappedContent = fmt.Sprintf("```%s\n%s\n```", language, fullContent)
				}
				renderedContent := util.ToMarkdown(wrappedContent, width-12, backgroundColor)

				// Update content
				vp.SetContent(renderedContent)

				// Auto-scroll if we were at bottom (>99% scrolled)
				if wasAtBottom {
					vp.GotoBottom()
				}
			}
		}

		var content string
		if vp != nil {
			// Show viewport content
			content = vp.View()
		} else {
			// Fallback to raw output if viewport not available
			wrappedContent := fullContent
			if language != "" {
				wrappedContent = fmt.Sprintf("```%s\n%s\n```", language, fullContent)
			}
			content = util.ToMarkdown(wrappedContent, width-12, backgroundColor)
		}

		// Apply bordered container with accent color
		borderedSection := styles.NewStyle().
			Background(backgroundColor).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(t.Accent()).
			Padding(0, 1).
			Width(width - 4).
			Render(content)

		return zone.Mark(zoneID, borderedSection)
	}

	// Collapsed state: Show truncated content with center-concat
	truncatedContent := util.TruncateHeightCenter(fullContent, truncHeight)

	// Wrap in code block with syntax highlighting
	wrappedContent := truncatedContent
	if language != "" {
		wrappedContent = fmt.Sprintf("```%s\n%s\n```", language, truncatedContent)
	}
	content := util.ToMarkdown(wrappedContent, width-6, backgroundColor)

	// Apply bordered container with muted color
	borderedSection := styles.NewStyle().
		Background(backgroundColor).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(t.TextMuted()).
		Padding(0, 1).
		Width(width - 4).
		Render(content)

	return zone.Mark(zoneID, borderedSection)
}
