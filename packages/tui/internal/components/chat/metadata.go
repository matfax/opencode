package chat

import (
	"encoding/json"
	"fmt"
)

// DiffContent represents diff content in metadata
type DiffContent struct {
	Diff string `json:"diff"`
}

// CodeContent represents code content with language
type CodeContent struct {
	Content  string `json:"content"`
	Language string `json:"language"`
}

// DiagnosticRange represents the range of a diagnostic
type DiagnosticRange struct {
	Start DiagnosticPosition `json:"start"`
	End   *DiagnosticPosition `json:"end,omitempty"`
}

// DiagnosticPosition represents a position in a file
type DiagnosticPosition struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}

// Diagnostic represents an LSP diagnostic
type Diagnostic struct {
	Range    DiagnosticRange `json:"range"`
	Severity int             `json:"severity"`
	Message  string          `json:"message"`
	Code     interface{}     `json:"code,omitempty"` // can be string or number
	Source   string          `json:"source,omitempty"`
}

// Diagnostics is a map of file paths to their diagnostics
type Diagnostics map[string][]Diagnostic

// BaseMetadata contains fields shared across all tool metadata
type BaseMetadata struct {
	Status      string       `json:"status,omitempty"`
	Instruction string       `json:"instruction,omitempty"`
	Attempt     int          `json:"attempt,omitempty"`
	MaxRetries  int          `json:"maxRetries,omitempty"`
	FullContent string       `json:"fullContent,omitempty"`
	Diagnostics Diagnostics  `json:"diagnostics,omitempty"`
	ShadowDiff  *DiffContent `json:"shadowDiff,omitempty"`
}

// ReadMetadata represents metadata for the read tool
type ReadMetadata struct {
	BaseMetadata
	Preview    string `json:"preview"`
	Summarized bool   `json:"summarized"`
	TotalLines int    `json:"totalLines"`
}

// SymbolMetadata represents metadata for the symbol tool
type SymbolMetadata struct {
	BaseMetadata
	Count int    `json:"count"`
	Error string `json:"error,omitempty"` // "no_lsp" or empty
}

// GrepMetadata represents metadata for the grep tool
type GrepMetadata struct {
	BaseMetadata
	Matches       int `json:"matches"`
	Truncated     bool `json:"truncated"`
	FilesSearched int `json:"filesSearched,omitempty"`
}

// GlobMetadata represents metadata for the glob tool
type GlobMetadata struct {
	BaseMetadata
	Count     int      `json:"count"`
	Truncated bool     `json:"truncated"`
	Errors    []string `json:"errors,omitempty"`
}

// Step represents a bash execution step
type Step struct {
	Type     string `json:"type"` // "command" or "thought"
	Text     string `json:"text"`
	ExitCode *int   `json:"exitCode,omitempty"`
}

// BashCommandData represents output for a specific command
type BashCommandData struct {
	Output   string `json:"output"`
	ExitCode int    `json:"exitCode,omitempty"`
}

// BashMetadata represents metadata for the bash tool
type BashMetadata struct {
	BaseMetadata
	Steps        []Step                     `json:"steps,omitempty"`
	Commands     map[string]BashCommandData `json:"commands,omitempty"`
	LastCommand  string                     `json:"lastCommand,omitempty"`
	LastExitCode int                        `json:"lastExitCode,omitempty"`
	ExitCode     int                        `json:"exitCode,omitempty"`
	ShellID      string                     `json:"shellID,omitempty"`
}

// EditMetadata represents metadata for the edit tool
type EditMetadata struct {
	BaseMetadata
	Diff    string       `json:"diff,omitempty"`
	Content *CodeContent `json:"content,omitempty"`
	Error   string       `json:"error,omitempty"`
}

// ReviewMetadata represents metadata for the review tool
type ReviewMetadata struct {
	BaseMetadata
	Passed      bool   `json:"passed"`
	Summary     string `json:"summary,omitempty"`
	Suggestions string `json:"suggestions,omitempty"`
	Error       string `json:"error,omitempty"`
}

// WriteMetadata represents metadata for the write tool
type WriteMetadata struct {
	BaseMetadata
}

// PredictMetadata represents metadata for the predict tool
type PredictMetadata struct {
	BaseMetadata
	Diff         string `json:"diff,omitempty"`
	Format       string `json:"format,omitempty"`
	PreviewLines int    `json:"previewLines,omitempty"`
	Error        string `json:"error,omitempty"`
}

// CreateRequirementsMetadata represents metadata for createRequirements
type CreateRequirementsMetadata struct {
	BaseMetadata
	NewShadowContent string `json:"newShadowContent,omitempty"`
	Error            string `json:"error,omitempty"`
}

// UpdateRequirementsMetadata represents metadata for updateRequirements
type UpdateRequirementsMetadata struct {
	BaseMetadata
	Error string `json:"error,omitempty"`
}

// TodoMetadata represents metadata for the todowrite tool
type TodoMetadata struct {
	BaseMetadata
	Todos []TodoItem `json:"todos"`
}

// TodoItem represents a single todo item
type TodoItem struct {
	Content    string `json:"content"`
	Status     string `json:"status"`
	ActiveForm string `json:"activeForm"`
}

// TaskMetadata represents metadata for the task tool
type TaskMetadata struct {
	BaseMetadata
	Summary []interface{} `json:"summary,omitempty"`
}

// DiffMetadata represents metadata for the diff tool
type DiffMetadata struct {
	BaseMetadata
	Mode     string `json:"mode"`
	Staged   bool   `json:"staged"`
	Unstaged bool   `json:"unstaged"`
}

// UnmarshalToolMetadata unmarshals raw metadata into the appropriate typed struct
// based on the tool name. Returns an error if the tool is not recognized.
func UnmarshalToolMetadata(toolName string, rawMetadata interface{}) (interface{}, error) {
	// Convert to JSON bytes for unmarshaling
	jsonBytes, err := json.Marshal(rawMetadata)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal metadata: %w", err)
	}

	// Exhaustive switch - every tool must be explicitly handled
	switch toolName {
	case "read":
		var m ReadMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal ReadMetadata: %w", err)
		}
		return m, nil

	case "symbol":
		var m SymbolMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal SymbolMetadata: %w", err)
		}
		return m, nil

	case "grep":
		var m GrepMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal GrepMetadata: %w", err)
		}
		return m, nil

	case "glob":
		var m GlobMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal GlobMetadata: %w", err)
		}
		return m, nil

	case "bash":
		var m BashMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal BashMetadata: %w", err)
		}
		return m, nil

	case "edit":
		var m EditMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal EditMetadata: %w", err)
		}
		return m, nil

	case "review":
		var m ReviewMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal ReviewMetadata: %w", err)
		}
		return m, nil

	case "write":
		var m WriteMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal WriteMetadata: %w", err)
		}
		return m, nil

	case "predict":
		var m PredictMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal PredictMetadata: %w", err)
		}
		return m, nil

	case "createrequirements":
		var m CreateRequirementsMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal CreateRequirementsMetadata: %w", err)
		}
		return m, nil

	case "updaterequirements":
		var m UpdateRequirementsMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal UpdateRequirementsMetadata: %w", err)
		}
		return m, nil

	case "todowrite":
		var m TodoMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal TodoMetadata: %w", err)
		}
		return m, nil

	case "task":
		var m TaskMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal TaskMetadata: %w", err)
		}
		return m, nil

	case "diff":
		var m DiffMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal DiffMetadata: %w", err)
		}
		return m, nil

	case "webfetch":
		// webfetch returns empty metadata, so use BaseMetadata
		var m BaseMetadata
		if err := json.Unmarshal(jsonBytes, &m); err != nil {
			return nil, fmt.Errorf("failed to unmarshal BaseMetadata: %w", err)
		}
		return m, nil

	default:
		// If we reach here, a tool is not handled - this is a compile-time contract violation
		return nil, fmt.Errorf("tool '%s' does not have metadata type defined - this is a bug", toolName)
	}
}
