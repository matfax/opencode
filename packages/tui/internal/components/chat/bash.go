package chat

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss/v2"
	zone "github.com/lrstanley/bubblezone/v2"
	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/util"
	"github.com/sst/opencode/internal/viewport"
)

func bashSections(metadata map[string]any, toolCall opencode.ToolPart, toolInputMap map[string]any, width int, messageID string, partIndex int, expandedCommands map[string]bool, viewports map[string]*viewport.Model) ([]string, map[string]*bashCommandData) {
	var sections []string
	bashData := make(map[string]*bashCommandData)
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	// 1. Command list with outputs from steps array
	type Step struct {
		Text     string `json:"text"`
		ExitCode *int   `json:"exitCode,omitempty"`
		Type     string `json:"type"`
	}

	var steps []Step
	if stepsRaw, ok := metadata["steps"].([]any); ok {
		for _, s := range stepsRaw {
			if stepMap, ok := s.(map[string]any); ok {
				step := Step{Type: "text-delta"}
				if text, ok := stepMap["text"].(string); ok {
					step.Text = text
				}
				if stepType, ok := stepMap["type"].(string); ok {
					step.Type = stepType
				}
				if exitCode, ok := stepMap["exitCode"].(float64); ok {
					exitCodeInt := int(exitCode)
					step.ExitCode = &exitCodeInt
				}
				steps = append(steps, step)
			}
		}
	}

	// Fallback: If no steps available yet, prefill with command from toolInputMap
	if len(steps) == 0 {
		if command, ok := toolInputMap["command"].(string); ok && command != "" {
			steps = append(steps, Step{
				Text: command,
				Type: "command",
			})
		}
	}

	// Get command outputs from metadata
	commandData := make(map[string]map[string]any)
	if cmds, ok := metadata["commands"].(map[string]any); ok {
		for cmd, data := range cmds {
			if dataMap, ok := data.(map[string]any); ok {
				commandData[cmd] = dataMap
			}
		}
	}

	var reasoningBuilder strings.Builder
	flushReasoning := func() {
		if reasoningBuilder.Len() == 0 {
			return
		}
		reasoningText := strings.TrimSpace(reasoningBuilder.String())
		if reasoningText != "" {
			color := t.Accent()
			if toolCall.State.Status != opencode.ToolPartStateStatusCompleted {
				color = t.TextMuted()
			}
			summaryWrapped := util.ToMarkdown(reasoningText, width, backgroundColor)
			summaryStyled := styles.NewStyle().
				Background(backgroundColor).
				Foreground(color).
				Render(summaryWrapped)
			sections = append(sections, summaryStyled)
		}
		reasoningBuilder.Reset()
	}

	// Display steps in order, interleaving commands and reasoning
	commandIndex := 0
	for _, step := range steps {
		switch step.Type {
		case "text-delta":
			reasoningBuilder.WriteString(step.Text)
			continue
		case "command":
			flushReasoning()
		default:
			continue
		}

		cmd := step.Text

		// Get CLI output and status from metadata
		var cliOutput string
		var exitCode *int
		var isExecuting bool

		if data, ok := commandData[cmd]; ok {
			if out, ok := data["output"].(string); ok {
				cliOutput = out
			}
			if ec, ok := data["exitCode"].(float64); ok {
				exitCodeInt := int(ec)
				exitCode = &exitCodeInt
			} else {
				isExecuting = true
			}
		}

		// Fallback to step's exitCode if not in metadata
		if exitCode == nil && step.ExitCode != nil {
			exitCode = step.ExitCode
		}

		// Command header with exit code
		cmdHeader := fmt.Sprintf("$ %s", cmd)
		if exitCode != nil {
			exitStyle := styles.NewStyle().Background(backgroundColor)
			if *exitCode == 0 {
				exitStyle = exitStyle.Foreground(t.Success())
			} else {
				exitStyle = exitStyle.Foreground(t.Error())
			}

			exitText := exitStyle.Bold(true).Render(fmt.Sprintf("[%d]", *exitCode))
			cmdHeader = fmt.Sprintf("%s %s", cmdHeader, exitText)
		} else if isExecuting {
			cmdHeader = fmt.Sprintf("%s %s", cmdHeader,
				styles.NewStyle().
					Background(backgroundColor).
					Foreground(t.Warning()).
					Render("[running...]"))
		}

		// Use unique zone ID based on message, part, and command index to avoid collisions with duplicate commands
		zoneID := fmt.Sprintf("bash-cmd-%s-%d-%d", messageID, partIndex, commandIndex)
		isExpanded := expandedCommands != nil && expandedCommands[zoneID]
		commandIndex++

		var commandSection string

		if isExpanded {
			// Expanded state: Show full output in viewport with border
			var vp *viewport.Model
			if viewports != nil && viewports[zoneID] != nil {
				vp = viewports[zoneID]

				// Update viewport with fresh content and auto-scroll if needed
				oldContent := vp.GetContent()
				if oldContent != cliOutput {
					// Content has changed, check if we should auto-scroll
					wasAtBottom := vp.AtBottom()

					// Update content
					vp.SetContent(cliOutput)

					// Auto-scroll if we were at bottom (>99% scrolled)
					if wasAtBottom {
						vp.GotoBottom()
					}
				}
			}

			// Render command header
			cmdHeaderStyled := styles.NewStyle().
				Background(backgroundColor).
				Foreground(t.TextMuted()).
				Render(cmdHeader)

			var content string
			if vp != nil {
				// Show viewport content
				content = cmdHeaderStyled + "\n\n" + vp.View()
			} else {
				// Fallback to raw output if viewport not available
				outputStyled := styles.NewStyle().
					Background(backgroundColor).
					Foreground(t.TextMuted()).
					Render(cliOutput)
				content = cmdHeaderStyled + "\n\n" + outputStyled
			}

			// Apply bordered container with accent color
			borderedSection := styles.NewStyle().
				Background(backgroundColor).
				Border(lipgloss.RoundedBorder()).
				BorderForeground(t.Accent()).
				Padding(0, 1).
				Width(width - 4).
				Render(content)

			commandSection = zone.Mark(zoneID, borderedSection)
		} else {
			// Collapsed state: Show command + last line preview with border
			cmdHeaderStyled := styles.NewStyle().
				Background(backgroundColor).
				Foreground(t.TextMuted()).
				Render(cmdHeader)

			var content string
			content = cmdHeaderStyled

			// CLI output (last line preview)
			if cliOutput != "" {
				lines := strings.Split(cliOutput, "\n")
				lastLine := ""
				for i := len(lines) - 1; i >= 0; i-- {
					if strings.TrimSpace(lines[i]) != "" {
						lastLine = strings.TrimSpace(lines[i])
						break
					}
				}

				if lastLine != "" {
					// Show last line in muted color
					lastLineStyled := styles.NewStyle().
						Background(backgroundColor).
						Foreground(t.TextMuted()).
						Italic(true).
						Render("  " + lastLine)
					content += "\n" + lastLineStyled
				}
			}

			// Apply bordered container with muted color
			borderedSection := styles.NewStyle().
				Background(backgroundColor).
				Border(lipgloss.RoundedBorder()).
				BorderForeground(t.TextMuted()).
				Padding(0, 1).
				Width(width - 4).
				Render(content)

			commandSection = zone.Mark(zoneID, borderedSection)
		}

		sections = append(sections, commandSection)

		// Store command data for click handling with tool reference
		// Use same unique key as zone ID
		toolCallCopy := toolCall
		bashData[zoneID] = &bashCommandData{
			command:   cmd,
			output:    cliOutput,
			exitCode:  exitCode,
			messageID: messageID,
			partIndex: partIndex,
			toolCall:  &toolCallCopy,
		}
	}

	// Flush any remaining reasoning text (e.g., after the final command or when no commands were run)
	flushReasoning()

	// 5. Error handling
	if toolCall.State.Status == opencode.ToolPartStateStatusError {
		errorText := fmt.Sprintf("⚠️ %s", toolCall.State.Error)
		errorStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.Error()).
			Render(errorText)
		sections = append(sections, errorStyled)
	}

	return sections, bashData
}
