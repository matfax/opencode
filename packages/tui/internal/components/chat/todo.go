package chat

import "github.com/sst/opencode-sdk-go"

func getTodoPhase(metadata map[string]any) string {
	todos, ok := metadata["todos"].([]any)
	if !ok || len(todos) == 0 {
		return "Plan"
	}

	counts := map[string]int{"pending": 0, "completed": 0}
	for _, item := range todos {
		if todo, ok := item.(map[string]any); ok {
			if status, ok := todo["status"].(string); ok {
				counts[status]++
			}
		}
	}

	total := len(todos)
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
	if toolCall.State.Status == opencode.ToolPartStateStatusCompleted {
		if metadata, ok := toolCall.State.Metadata.(map[string]any); ok {
			return getTodoPhase(metadata)
		}
	}
	return "Plan"
}
