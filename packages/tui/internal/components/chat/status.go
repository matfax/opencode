package chat

import (
	"strings"
	"time"

	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
)

// renderToolStatus renders the status message with animated dots for running tools
func renderToolStatus(status string, toolCall opencode.ToolPart) string {
	if toolCall.State.Status != opencode.ToolPartStateStatusRunning {
		return ""
	}

	statusMessage := "Starting"
	if status != "" {
		statusMessage = status
	}

	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	// Add spinner with animated dots
	statusMessage = "🔄 " + statusMessage
	dots := (time.Now().Second() % 3) + 1
	statusMessage += strings.Repeat(".", dots)

	statusStyled := styles.NewStyle().
		Background(backgroundColor).
		Foreground(t.Accent()).
		Bold(true).
		Render(statusMessage)

	return statusStyled
}
