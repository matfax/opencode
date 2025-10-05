package chat

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss/v2"
	"github.com/charmbracelet/lipgloss/v2/compat"
	"github.com/charmbracelet/x/ansi"
	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/app"
	"github.com/sst/opencode/internal/commands"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/util"
	"github.com/sst/opencode/internal/viewport"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

type blockRenderer struct {
	textColor       compat.AdaptiveColor
	backgroundColor compat.AdaptiveColor
	border          bool
	borderColor     *compat.AdaptiveColor
	borderLeft      bool
	borderRight     bool
	paddingTop      int
	paddingBottom   int
	paddingLeft     int
	paddingRight    int
	marginTop       int
	marginBottom    int
}

type renderingOption func(*blockRenderer)

func WithTextColor(color compat.AdaptiveColor) renderingOption {
	return func(c *blockRenderer) {
		c.textColor = color
	}
}

func WithBackgroundColor(color compat.AdaptiveColor) renderingOption {
	return func(c *blockRenderer) {
		c.backgroundColor = color
	}
}

func WithNoBorder() renderingOption {
	return func(c *blockRenderer) {
		c.border = false
		c.paddingLeft++
		c.paddingRight++
	}
}

func WithBorderColor(color compat.AdaptiveColor) renderingOption {
	return func(c *blockRenderer) {
		c.borderColor = &color
	}
}

func WithBorderLeft() renderingOption {
	return func(c *blockRenderer) {
		c.borderLeft = true
		c.borderRight = false
	}
}

func WithBorderRight() renderingOption {
	return func(c *blockRenderer) {
		c.borderLeft = false
		c.borderRight = true
	}
}

func WithBorderBoth(value bool) renderingOption {
	return func(c *blockRenderer) {
		if value {
			c.borderLeft = true
			c.borderRight = true
		}
	}
}

func WithMarginTop(padding int) renderingOption {
	return func(c *blockRenderer) {
		c.marginTop = padding
	}
}

func WithMarginBottom(padding int) renderingOption {
	return func(c *blockRenderer) {
		c.marginBottom = padding
	}
}

func WithPadding(padding int) renderingOption {
	return func(c *blockRenderer) {
		c.paddingTop = padding
		c.paddingBottom = padding
		c.paddingLeft = padding
		c.paddingRight = padding
	}
}

func WithPaddingLeft(padding int) renderingOption {
	return func(c *blockRenderer) {
		c.paddingLeft = padding
	}
}

func WithPaddingRight(padding int) renderingOption {
	return func(c *blockRenderer) {
		c.paddingRight = padding
	}
}

func WithPaddingTop(padding int) renderingOption {
	return func(c *blockRenderer) {
		c.paddingTop = padding
	}
}

func WithPaddingBottom(padding int) renderingOption {
	return func(c *blockRenderer) {
		c.paddingBottom = padding
	}
}

func renderContentBlock(
	app *app.App,
	content string,
	width int,
	options ...renderingOption,
) string {
	t := theme.CurrentTheme()
	renderer := &blockRenderer{
		textColor:       t.TextMuted(),
		backgroundColor: t.BackgroundPanel(),
		border:          true,
		borderLeft:      true,
		borderRight:     false,
		paddingTop:      1,
		paddingBottom:   1,
		paddingLeft:     2,
		paddingRight:    2,
	}
	for _, option := range options {
		option(renderer)
	}

	borderColor := t.BackgroundPanel()
	if renderer.borderColor != nil {
		borderColor = *renderer.borderColor
	}

	style := styles.NewStyle().
		Foreground(renderer.textColor).
		Background(renderer.backgroundColor).
		PaddingTop(renderer.paddingTop).
		PaddingBottom(renderer.paddingBottom).
		PaddingLeft(renderer.paddingLeft).
		PaddingRight(renderer.paddingRight).
		AlignHorizontal(lipgloss.Left)

	if renderer.border {
		style = style.
			BorderStyle(lipgloss.ThickBorder()).
			BorderLeft(true).
			BorderRight(true).
			BorderLeftForeground(t.BackgroundPanel()).
			BorderLeftBackground(t.Background()).
			BorderRightForeground(t.BackgroundPanel()).
			BorderRightBackground(t.Background())

		if renderer.borderLeft {
			style = style.BorderLeftForeground(borderColor)
		}
		if renderer.borderRight {
			style = style.BorderRightForeground(borderColor)
		}
	} else {
		style = style.PaddingLeft(renderer.paddingLeft).PaddingRight(renderer.paddingRight)
	}

	content = style.Render(content)
	if renderer.marginTop > 0 {
		for range renderer.marginTop {
			content = "\n" + content
		}
	}
	if renderer.marginBottom > 0 {
		for range renderer.marginBottom {
			content = content + "\n"
		}
	}

	return content
}

func renderText(
	app *app.App,
	message opencode.MessageUnion,
	text string,
	author string,
	showToolDetails bool,
	width int,
	extra string,
	isThinking bool,
	isQueued bool,
	shimmer bool,
	fileParts []opencode.FilePart,
	agentParts []opencode.AgentPart,
	toolCalls ...opencode.ToolPart,
) string {
	t := theme.CurrentTheme()

	var ts time.Time
	backgroundColor := t.BackgroundPanel()
	var content string
	switch casted := message.(type) {
	case opencode.AssistantMessage:
		backgroundColor = t.Background()
		if isThinking {
			backgroundColor = t.BackgroundPanel()
		}
		ts = time.UnixMilli(int64(casted.Time.Created))
		if casted.Time.Completed > 0 {
			ts = time.UnixMilli(int64(casted.Time.Completed))
		}
		content = util.ToMarkdown(text, width, backgroundColor)
		if isThinking {
			var label string
			if shimmer {
				label = util.Shimmer("Thinking...", backgroundColor, t.TextMuted(), t.Accent())
			} else {
				label = styles.NewStyle().Background(backgroundColor).Foreground(t.TextMuted()).Render("Thinking...")
			}
			label = styles.NewStyle().Background(backgroundColor).Width(width - 6).Render(label)
			content = label + "\n\n" + content
		} else if strings.TrimSpace(text) == "Generating..." {
			label := util.Shimmer(text, backgroundColor, t.TextMuted(), t.Text())
			label = styles.NewStyle().Background(backgroundColor).Width(width - 6).Render(label)
			content = label
		}
	case opencode.UserMessage:
		ts = time.UnixMilli(int64(casted.Time.Created))
		base := styles.NewStyle().Foreground(t.Text()).Background(backgroundColor)

		var result strings.Builder
		lastEnd := int64(0)

		// Apply highlighting to filenames and base style to rest of text BEFORE wrapping
		textLen := int64(len(text))

		// Collect all parts to highlight (both file and agent parts)
		type highlightPart struct {
			start int64
			end   int64
			color compat.AdaptiveColor
		}
		var highlights []highlightPart

		// Add file parts with secondary color
		for _, filePart := range fileParts {
			highlights = append(highlights, highlightPart{
				start: filePart.Source.Text.Start,
				end:   filePart.Source.Text.End,
				color: t.Secondary(),
			})
		}

		// Add agent parts with secondary color (same as file parts)
		for _, agentPart := range agentParts {
			highlights = append(highlights, highlightPart{
				start: agentPart.Source.Start,
				end:   agentPart.Source.End,
				color: t.Secondary(),
			})
		}

		// Sort highlights by start position
		slices.SortFunc(highlights, func(a, b highlightPart) int {
			if a.start < b.start {
				return -1
			}
			if a.start > b.start {
				return 1
			}
			return 0
		})

		// Merge overlapping highlights to prevent duplication
		merged := make([]highlightPart, 0)
		for _, part := range highlights {
			if len(merged) == 0 {
				merged = append(merged, part)
				continue
			}

			last := &merged[len(merged)-1]
			// If current part overlaps with the last one, merge them
			if part.start <= last.end {
				if part.end > last.end {
					last.end = part.end
				}
			} else {
				merged = append(merged, part)
			}
		}

		for _, part := range merged {
			highlight := base.Foreground(part.color)
			start, end := part.start, part.end

			if end > textLen {
				end = textLen
			}
			if start > textLen {
				start = textLen
			}

			if start > lastEnd {
				result.WriteString(base.Render(text[lastEnd:start]))
			}
			if start < end {
				result.WriteString(highlight.Render(text[start:end]))
			}

			lastEnd = end
		}

		if lastEnd < textLen {
			result.WriteString(base.Render(text[lastEnd:]))
		}

		// wrap styled text
		styledText := result.String()
		styledText = strings.ReplaceAll(styledText, "-", "\u2011")
		wrappedText := ansi.WordwrapWc(styledText, width-6, " ")
		wrappedText = strings.ReplaceAll(wrappedText, "\u2011", "-")
		content = base.Width(width - 6).Render(wrappedText)
		if isQueued {
			queuedStyle := styles.NewStyle().Background(t.Accent()).Foreground(t.BackgroundPanel()).Bold(true).Padding(0, 1)
			content = queuedStyle.Render("QUEUED") + "\n\n" + content
		}
	}

	timestamp := ts.
		Local().
		Format("02 Jan 2006 03:04 PM")
	if time.Now().Format("02 Jan 2006") == timestamp[:11] {
		timestamp = timestamp[12:]
	}
	timestamp = styles.NewStyle().
		Background(backgroundColor).
		Foreground(t.TextMuted()).
		Render(" (" + timestamp + ")")

	// Check if this is an assistant message with agent information
	var modelAndAgentSuffix string
	if assistantMsg, ok := message.(opencode.AssistantMessage); ok && assistantMsg.Mode != "" {
		// Find the agent index by name to get the correct color
		var agentIndex int
		for i, agent := range app.Agents {
			if agent.Name == assistantMsg.Mode {
				agentIndex = i
				break
			}
		}

		// Get agent color based on the original agent index (same as status bar)
		agentColor := util.GetAgentColor(agentIndex)

		// Style the agent name with the same color as status bar
		agentName := cases.Title(language.Und).String(assistantMsg.Mode)
		styledAgentName := styles.NewStyle().
			Background(backgroundColor).
			Foreground(agentColor).
			Render(agentName + " ")
		styledModelID := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.TextMuted()).
			Render(assistantMsg.ModelID)
		modelAndAgentSuffix = styledAgentName + styledModelID
	}

	var info string
	if modelAndAgentSuffix != "" {
		info = modelAndAgentSuffix + timestamp
	} else {
		info = author + timestamp
	}
	if !showToolDetails && toolCalls != nil && len(toolCalls) > 0 {
		for _, toolCall := range toolCalls {
			title := renderFullToolTitle(toolCall, width-2)
			style := styles.NewStyle()
			if toolCall.State.Status == opencode.ToolPartStateStatusError {
				style = style.Foreground(t.Error())
			}
			title = style.Render(title)
			title = "\n∟ " + title
			content = content + title
		}
	}

	sections := []string{content}
	if extra != "" {
		sections = append(sections, "\n"+extra+"\n")
	}
	sections = append(sections, info)
	content = strings.Join(sections, "\n")

	switch message.(type) {
	case opencode.UserMessage:
		borderColor := t.Secondary()
		if isQueued {
			borderColor = t.Accent()
		}
		return renderContentBlock(
			app,
			content,
			width,
			WithTextColor(t.Text()),
			WithBorderColor(borderColor),
		)
	case opencode.AssistantMessage:
		if isThinking {
			return renderContentBlock(
				app,
				content,
				width,
				WithTextColor(t.Text()),
				WithBackgroundColor(t.BackgroundPanel()),
				WithBorderColor(t.BackgroundPanel()),
			)
		}
		return renderContentBlock(
			app,
			content,
			width,
			WithNoBorder(),
			WithBackgroundColor(t.Background()),
		)
	}
	return ""
}

func renderToolDetails(
	app *app.App,
	toolCall opencode.ToolPart,
	permission opencode.Permission,
	width int,
	bashCommandZones *map[string]*bashCommandData,
	messageID string,
	partIndex int,
	expandedBashCommands map[string]bool,
	bashViewports map[string]*viewport.Model,
) string {
	measure := util.Measure("chat.renderToolDetails")
	defer measure("tool", toolCall.Tool)
	ignoredTools := []string{"todoread"}
	if slices.Contains(ignoredTools, toolCall.Tool) {
		return ""
	}

	if toolCall.State.Status == opencode.ToolPartStateStatusPending {
		title := renderFullToolTitle(toolCall, width)
		return renderContentBlock(app, title, width)
	}

	var result *string
	if toolCall.State.Output != "" {
		result = &toolCall.State.Output
	}

	toolInputMap := make(map[string]any)
	if toolCall.State.Input != nil {
		value := toolCall.State.Input
		if m, ok := value.(map[string]any); ok {
			toolInputMap = m
			keys := make([]string, 0, len(toolInputMap))
			for key := range toolInputMap {
				keys = append(keys, key)
			}
			slices.Sort(keys)
		}
	}

	body := ""
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()
	borderColor := t.BackgroundPanel()
	defaultStyle := styles.NewStyle().Background(backgroundColor).Width(width - 6).Render
	baseStyle := styles.NewStyle().Background(backgroundColor).Foreground(t.Text()).Render
	mutedStyle := styles.NewStyle().Background(backgroundColor).Foreground(t.TextMuted()).Render

	permissionContent := ""
	if permission.ID != "" {
		borderColor = t.Warning()

		base := styles.NewStyle().Background(backgroundColor)
		text := base.Foreground(t.Text()).Bold(true).Render
		muted := base.Foreground(t.TextMuted()).Render
		permissionContent = "Permission required to run this tool:\n\n"
		permissionContent += text("enter ") + muted("accept   ")
		permissionContent += text("a") + muted(" accept always   ")
		permissionContent += text("s") + muted(" reject syntax   ")
		permissionContent += text("r") + muted(" reject approach   ")
		permissionContent += text("i") + muted(" reject intent   ")
		permissionContent += text("esc") + muted(" reject with message")

	}

	if permission.Metadata != nil {
		metadata, ok := toolCall.State.Metadata.(map[string]any)
		if metadata == nil || !ok {
			metadata = map[string]any{}
		}
		maps.Copy(metadata, permission.Metadata)
		toolCall.State.Metadata = metadata
	}

	if metadata, ok := toolCall.State.Metadata.(map[string]any); ok {
		// Render status for running tools (crosscutting concern)
		if status := renderToolStatus(metadata, toolCall); status != "" {
			body = status + "\n\n"
		}

		// Render instructions/goal/description for running tools (crosscutting concern)
		if instructions := renderToolInstructions(toolInputMap, toolCall, width); instructions != "" {
			body += instructions + "\n\n"
		}

		switch toolCall.Tool {
		case "read":
			var preview any
			if metadata != nil {
				preview = metadata["preview"]
			}
			if preview != nil && toolInputMap["filePath"] != nil {
				filename := toolInputMap["filePath"].(string)
				body += preview.(string)
				body = util.RenderFile(filename, body, width, util.WithTruncate(6))
			}
		case "edit":
			if filename, ok := toolInputMap["filePath"].(string); ok {
				sections := editSections(metadata, toolCall, width, filename)
				body += strings.Join(sections, "\n\n")
			}
		case "write":
			if filename, ok := toolInputMap["filePath"].(string); ok {
				if content, ok := toolInputMap["content"].(string); ok {
					body += util.RenderFile(filename, content, width)
					if diagnostics := renderDiagnostics(metadata, filename, backgroundColor, width-4); diagnostics != "" {
						body += "\n\n" + diagnostics
					}
				}
			}
		case "bash":
			sections, bashData := bashSections(metadata, toolCall, toolInputMap, width, messageID, partIndex, expandedBashCommands, bashViewports)
			body += strings.Join(sections, "\n\n")
			// Thread bash command data back to messagesComponent for click handling
			if bashCommandZones != nil {
				for cmd, data := range bashData {
					(*bashCommandZones)[cmd] = data
				}
			}
		case "webfetch":
			if format, ok := toolInputMap["format"].(string); ok && result != nil {
				body = *result
				body = util.TruncateHeight(body, 10)
				if format == "html" || format == "markdown" {
					body = util.ToMarkdown(body, width, backgroundColor)
				}
			}
		case "todowrite":
			todos := metadata["todos"]
			if todos != nil {
				for _, item := range todos.([]any) {
					todo := item.(map[string]any)
					content := todo["content"]
					if content == nil {
						continue
					}
					switch todo["status"] {
					case "completed":
						body += fmt.Sprintf("- [x] %s\n", content)
					case "cancelled":
						// strike through cancelled todo
						body += fmt.Sprintf("- [ ] ~~%s~~\n", content)
					case "in_progress":
						// highlight in progress todo
						body += fmt.Sprintf("- [ ] `%s`\n", content)
					default:
						body += fmt.Sprintf("- [ ] %s\n", content)
					}
				}
				body = util.ToMarkdown(body, width, backgroundColor)
			}
		case "task":
			summary := metadata["summary"]
			if summary != nil {
				toolcalls := summary.([]any)
				steps := []string{}
				for _, item := range toolcalls {
					data, _ := json.Marshal(item)
					var toolCall opencode.ToolPart
					_ = json.Unmarshal(data, &toolCall)
					step := renderFullToolTitle(toolCall, width-2)
					step = "∟ " + step
					steps = append(steps, step)
				}
				body = strings.Join(steps, "\n")

				body += "\n\n"

				// Build navigation hint with proper spacing
				cycleKeybind := app.Keybind(commands.SessionChildCycleCommand)
				cycleReverseKeybind := app.Keybind(commands.SessionChildCycleReverseCommand)

				var navParts []string
				if cycleKeybind != "" {
					navParts = append(navParts, baseStyle(cycleKeybind))
				}
				if cycleReverseKeybind != "" {
					navParts = append(navParts, baseStyle(cycleReverseKeybind))
				}

				if len(navParts) > 0 {
					body += strings.Join(navParts, mutedStyle(", ")) + mutedStyle(" navigate child sessions")
				}
			}
			body = defaultStyle(body)
		default:
			if result == nil {
				empty := ""
				result = &empty
			}
			body = *result
			body = util.TruncateHeight(body, 10)
			body = defaultStyle(body)
		}
	}

	error := ""
	if toolCall.State.Status == opencode.ToolPartStateStatusError {
		error = toolCall.State.Error
	}

	if error != "" {
		errorContent := styles.NewStyle().
			Width(width - 6).
			Foreground(t.Error()).
			Background(backgroundColor).
			Render(error)

		if body == "" {
			body = errorContent
		} else {
			body += "\n\n" + errorContent
		}
	}

	if body == "" && error == "" && result != nil {
		body = *result
		body = util.TruncateHeight(body, 10)
		body = defaultStyle(body)
	}

	if body == "" {
		body = defaultStyle("")
	}

	fullTitle := renderFullToolTitle(toolCall, width)
	content := fullTitle + "\n" + body

	if permissionContent != "" {
		permissionContent = styles.NewStyle().
			Background(backgroundColor).
			Padding(1, 2).
			Render(permissionContent)
		content += "\n\n" + permissionContent
	}

	return renderContentBlock(
		app,
		content,
		width,
		WithBorderColor(borderColor),
		WithBorderBoth(permission.ID != ""),
	)
}
