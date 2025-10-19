package chat

import (
	"regexp"
	"strings"

	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/styles"
	"github.com/sst/opencode/internal/theme"
	"github.com/sst/opencode/internal/util"
)

func symbolSections(metadata SymbolMetadata, toolCall opencode.ToolPart, width int) []string {
	var sections []string
	t := theme.CurrentTheme()
	backgroundColor := t.BackgroundPanel()

	if toolCall.State.Output == "" {
		return sections
	}

	output := toolCall.State.Output

	// Parse the output format:
	// name: {symbol}
	// file: {filepath}:{line}
	// ----
	// {code}
	// [optionally: ---- Code Requirements: {shadow}]

	// Split by double newlines to get individual symbol results
	symbolResults := strings.Split(output, "\n\n")

	for _, result := range symbolResults {
		if strings.TrimSpace(result) == "" || result == "No symbols found" {
			continue
		}

		lines := strings.Split(result, "\n")
		if len(lines) < 4 {
			// Not enough lines for valid symbol result, show as-is
			sections = append(sections, styles.NewStyle().
				Background(backgroundColor).
				Foreground(t.Text()).
				Render(result))
			continue
		}

		// Extract name and file
		var symbolName, filePath string
		var codeStartIdx int

		for i, line := range lines {
			if strings.HasPrefix(line, "name: ") {
				symbolName = strings.TrimPrefix(line, "name: ")
			} else if strings.HasPrefix(line, "file: ") {
				fileInfo := strings.TrimPrefix(line, "file: ")
				// Extract just the filename (before the colon and line number)
				if idx := strings.LastIndex(fileInfo, ":"); idx > 0 {
					filePath = fileInfo[:idx]
				} else {
					filePath = fileInfo
				}
			} else if line == "----" {
				codeStartIdx = i + 1
				break
			}
		}

		// Extract code section (from ---- to end or next ----)
		var codeLines []string
		var shadowContent string
		inShadow := false

		for i := codeStartIdx; i < len(lines); i++ {
			line := lines[i]
			if line == "----" && i > codeStartIdx {
				// Start of shadow section
				inShadow = true
				continue
			}
			if inShadow {
				if line == "Code Requirements:" {
					continue
				}
				shadowContent += line + "\n"
			} else {
				codeLines = append(codeLines, line)
			}
		}

		code := strings.Join(codeLines, "\n")

		// Header section
		headerText := symbolName
		if filePath != "" {
			headerText += " • " + filePath
		}
		header := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.Accent()).
			Bold(true).
			Render(headerText)
		sections = append(sections, header)

		// Render code with syntax highlighting
		if code != "" && filePath != "" {
			// Check if code has line numbers (format: 00123| code)
			hasLineNumbers := false
			if len(codeLines) > 0 {
				matched, _ := regexp.MatchString(`^\d{5}\|`, codeLines[0])
				hasLineNumbers = matched
			}

			// Strip line numbers if present for rendering
			if hasLineNumbers {
				strippedLines := make([]string, len(codeLines))
				for i, line := range codeLines {
					// Remove the "00123| " prefix
					if matched, _ := regexp.MatchString(`^\d{5}\|`, line); matched {
						strippedLines[i] = line[7:] // Skip "00123| " (5 digits + "| ")
					} else {
						strippedLines[i] = line
					}
				}
				code = strings.Join(strippedLines, "\n")
			}

			renderedCode := util.RenderFile(filePath, code, width, util.WithTruncate(20))
			sections = append(sections, styles.NewStyle().
				Background(backgroundColor).
				Render(renderedCode))
		}

		// Render shadow requirements if present
		if shadowContent != "" {
			shadowHeader := styles.NewStyle().
				Background(backgroundColor).
				Foreground(t.TextMuted()).
				Italic(true).
				Render("Code Requirements:")

			shadowMarkdown := util.ToMarkdown(strings.TrimSpace(shadowContent), width, backgroundColor)
			shadowStyled := styles.NewStyle().
				Background(backgroundColor).
				Foreground(t.TextMuted()).
				Render(shadowMarkdown)

			sections = append(sections, shadowHeader, shadowStyled)
		}
	}

	// Error handling
	hasError := false
	var errorMessage string
	if toolCall.State.Status == opencode.ToolPartStateStatusError {
		hasError = true
		errorMessage = toolCall.State.Error
	} else if metadata.Error != "" {
		hasError = true
		// Map error codes to user-friendly messages
		if metadata.Error == "no_lsp" {
			errorMessage = "No LSP servers configured. Symbol search requires language servers."
		} else {
			errorMessage = metadata.Error
		}
	}

	if hasError && errorMessage != "" {
		errorStyled := styles.NewStyle().
			Background(backgroundColor).
			Foreground(t.Error()).
			Render(errorMessage)
		sections = append(sections, errorStyled)
	}

	return sections
}
