package chat

import (
	"github.com/sst/opencode-sdk-go"
)

func getTodoPhase(metadata TodoMetadata) string {
	if len(metadata.Todos) == 0 {
		return "Plan"
	}

	counts := map[string]int{"pending": 0, "completed": 0}
	for _, todo := range metadata.Todos {
		counts[todo.Status]++
	}

	total := len(metadata.Todos)
	switch {
	case counts["pending"] == total:
		return "Creating plan"
	case counts["completed"] == total:
		return "Completing plan"
	default:
		return "Updating plan"
	}
}

func getTodoTitle(toolCall opencode.ToolPart) string {
	// Try to unmarshal metadata
	typedMetadata, err := UnmarshalToolMetadata(toolCall.Tool, toolCall.State.Metadata)
	if err != nil {
		return "Plan"
	}

	// Type assert to TodoMetadata
	if todoMeta, ok := typedMetadata.(TodoMetadata); ok {
		return getTodoPhase(todoMeta)
	}

	return "Plan"
}
