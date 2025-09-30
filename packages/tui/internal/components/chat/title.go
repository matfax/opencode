package chat

import (
	"fmt"
	"slices"
	"strings"

	"github.com/charmbracelet/lipgloss/v2"
	"github.com/muesli/reflow/truncate"
	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/util"
	"golang.org/x/exp/constraints"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func renderFullToolTitle(
	toolCall opencode.ToolPart,
	width int,
) (fullTitle string) {
	var attempt, maxRetries float64
	if metadata, ok := toolCall.State.Metadata.(map[string]any); ok {
		if a, ok := metadata["attempt"].(float64); ok {
			attempt = a
		}
		if m, ok := metadata["max_retries"].(float64); ok {
			maxRetries = m
		}
	}

	backgroundColor := theme.CurrentTheme().BackgroundPanel()

	title := renderToolTitle(toolCall, width, attempt, maxRetries)
	style := styles.NewStyle().
		Background(backgroundColor).
		PaddingBottom(1).
		Width(width - 4)

	return style.Render(title)
}

func renderToolTitle[N constraints.Float | constraints.Integer](
	toolCall opencode.ToolPart,
	width int,
	attempt N,
	maxRetries N,
) string {
	if toolCall.State.Status == opencode.ToolPartStateStatusPending {
		title := renderToolAction(toolCall.Tool)
		t := theme.CurrentTheme()
		shiny := util.Shimmer(title, t.BackgroundPanel(), t.TextMuted(), t.Accent())
		return styles.NewStyle().Background(t.BackgroundPanel()).Width(width - 6).Render(shiny)
	}

	toolArgs := ""
	toolArgsMap := make(map[string]any)
	if toolCall.State.Input != nil {
		value := toolCall.State.Input
		if m, ok := value.(map[string]any); ok {
			toolArgsMap = m

			keys := make([]string, 0, len(toolArgsMap))
			for key := range toolArgsMap {
				keys = append(keys, key)
			}
			slices.Sort(keys)
			firstKey := ""
			if len(keys) > 0 {
				firstKey = keys[0]
			}

			toolArgs = renderArgs(&toolArgsMap, firstKey)
		}
	}

	title := renderToolName(toolCall.Tool)
	switch toolCall.Tool {
	case "read":
		toolArgs = renderArgs(&toolArgsMap, "filePath")
		title = fmt.Sprintf("%s %s", title, toolArgs)
	case "edit", "write":
		if filename, ok := toolArgsMap["filePath"].(string); ok {
			title = fmt.Sprintf("%s %s", title, util.Relative(filename))
		}
	case "bash":
		if description, ok := toolArgsMap["description"].(string); ok {
			title = fmt.Sprintf("%s %s", title, description)
		}
	case "task":
		description := toolArgsMap["description"]
		subagent := toolArgsMap["subagent_type"]
		if description != nil && subagent != nil {
			title = fmt.Sprintf("%s[%s] %s", title, subagent, description)
		} else if description != nil {
			title = fmt.Sprintf("%s %s", title, description)
		}
	case "webfetch":
		toolArgs = renderArgs(&toolArgsMap, "url")
		title = fmt.Sprintf("%s %s", title, toolArgs)
	case "todowrite":
		title = getTodoTitle(toolCall)
	case "todoread":
		return "Plan"
	case "invalid":
		if actualTool, ok := toolArgsMap["tool"].(string); ok {
			title = renderToolName(actualTool)
		}
	default:
		toolName := renderToolName(toolCall.Tool)
		title = fmt.Sprintf("%s %s", toolName, toolArgs)
	}

	if attempt > 1 && maxRetries > 1 {
		t := theme.CurrentTheme()
		attemptStr := fmt.Sprintf("Attempt %d/%d", int(attempt), int(maxRetries))
		attemptBox := styles.NewStyle().
			Background(t.Accent()).
			Foreground(t.Background()).
			Bold(true).
			Padding(0, 1).
			Render(attemptStr)

		boxWidth := lipgloss.Width(attemptBox)
		marginLen := 2
		leftMaxLen := (width - 6) - boxWidth - marginLen
		titleTrunc := truncate.StringWithTail(title, uint(leftMaxLen), "…")

		titleLeft := styles.NewStyle().
			Background(t.BackgroundPanel()).
			Foreground(t.TextMuted()).
			Render(titleTrunc)

		spacer := strings.Repeat(" ", marginLen)
		spacerStyled := styles.NewStyle().Background(t.BackgroundPanel()).Render(spacer)

		fullTitle := titleLeft + spacerStyled + attemptBox
		return styles.NewStyle().Background(t.BackgroundPanel()).Width(width - 6).Render(fullTitle)
	}

	title = truncate.StringWithTail(title, uint(width-6), "...")
	if toolCall.State.Error != "" {
		t := theme.CurrentTheme()
		title = styles.NewStyle().Foreground(t.Error()).Render(title)
	}
	return title
}

func renderToolAction(name string) string {
	switch name {
	case "task":
		return "Delegating..."
	case "bash":
		return "Writing command..."
	case "edit":
		return "Preparing edit..."
	case "webfetch":
		return "Fetching from the web..."
	case "glob":
		return "Finding files..."
	case "grep":
		return "Searching content..."
	case "list":
		return "Listing directory..."
	case "read":
		return "Reading file..."
	case "write":
		return "Preparing write..."
	case "todowrite", "todoread":
		return "Planning..."
	case "patch":
		return "Preparing patch..."
	}
	return "Working..."
}

func renderArgs(args *map[string]any, titleKey string) string {
	if args == nil || len(*args) == 0 {
		return ""
	}

	keys := make([]string, 0, len(*args))
	for key := range *args {
		keys = append(keys, key)
	}
	slices.Sort(keys)

	title := ""
	parts := []string{}
	for _, key := range keys {
		value := (*args)[key]
		if value == nil {
			continue
		}
		if key == "filePath" || key == "path" {
			if strValue, ok := value.(string); ok {
				value = util.Relative(strValue)
			}
		}
		if key == titleKey {
			title = fmt.Sprintf("%s", value)
			continue
		}
		if key == "prompt" || key == "content" || key == "url" || key == "instructions" || key == "description" || key == "query" {
			continue
		}
		if key == "command" {
			// Only show without parameters
			if strValue, ok := value.(string); ok {
				value = strings.SplitN(strValue, " ", 2)[0]
			}
		}
		parts = append(parts, fmt.Sprintf("%s=%v", key, value))
	}
	if len(parts) == 0 {
		return title
	}
	return fmt.Sprintf("%s (%s)", title, strings.Join(parts, ", "))
}

func renderToolName(name string) string {
	switch name {
	case "bash":
		return "Shell"
	case "webfetch":
		return "Fetch"
	case "invalid":
		return "Invalid"
	default:
		normalizedName := name
		if after, ok := strings.CutPrefix(name, "opencode_"); ok {
			normalizedName = after
		}
		return cases.Title(language.Und).String(normalizedName)
	}
}
