import { Agent } from "../agent/agent"
import { ProviderTransform } from "../provider/transform"
import { Provider } from "../provider/provider"
import { Template } from "../util/template"
import { minimatch } from "minimatch"
import path from "path"
import { Instance } from "../project/instance"

/**
 * Match a model for a file path based on glob patterns.
 * Returns the matched model string or null if no match.
 */
function matchModelForFile(
  config: { default: string; overrides: Record<string, string> },
  filePath: string,
): string | null {
  const relative = path.relative(Instance.directory, filePath)

  for (const [pattern, model] of Object.entries(config.overrides)) {
    if (minimatch(relative, pattern)) {
      return model
    }
  }

  return null // Use default model from 3-tier fallback
}

/**
 * Build params for support model calls with proper option merging and model fallback.
 *
 * Model selection (4-tier fallback with glob matching):
 * 1. Support agent's glob-matched model (if modelConfig with overrides and filePath match)
 * 2. Support agent's configured model (if exists)
 * 3. Calling agent's model (primary/subagent that invoked the tool)
 * 4. Global default model
 *
 * Parameter precedence (matches main prompt flow):
 * - temperature/topP: agent override → ProviderTransform → model.info
 * - options (reasoningEffort, thinking, etc.): ProviderTransform → model.info.options → agent.options
 *
 * Prompt handling:
 * - If support agent has custom prompt, loads and substitutes it
 * - Otherwise returns undefined, caller should use tool-specific fallback template
 */
export async function buildSupportModelParams(
  supportAgentName: string,
  callingAgentName: string, // from ctx.agent
  sessionID?: string,
  filePath?: string, // Optional file path for glob-based model matching
) {
  // Get both agents
  const supportAgent = await Agent.get(supportAgentName)
  const callingAgent = await Agent.get(callingAgentName)

  // Filter support agent by mode: only use if mode is "support" or "all"
  const useSupportAgent =
    supportAgent && (supportAgent.mode === "support" || supportAgent.mode === "all") ? supportAgent : undefined

  // 4-tier model fallback with glob matching
  let modelInfo

  // Tier 1: Try glob-based override if filePath provided and modelConfig exists
  if (useSupportAgent?.modelConfig && filePath) {
    const matchedModel = matchModelForFile(useSupportAgent.modelConfig, filePath)
    if (matchedModel) {
      const parsed = Provider.parseModel(matchedModel)
      modelInfo = await Provider.getModel(parsed.providerID, parsed.modelID)
    }
  }

  // Tier 2-4: Standard fallback
  if (!modelInfo) {
    modelInfo = useSupportAgent?.model
      ? await Provider.getModel(useSupportAgent.model.providerID, useSupportAgent.model.modelID)
      : callingAgent?.model
        ? await Provider.getModel(callingAgent.model.providerID, callingAgent.model.modelID)
        : await (async () => {
            const def = await Provider.defaultModel()
            return Provider.getModel(def.providerID, def.modelID)
          })()
  }

  // Load custom prompt if specified (prompt field is a file path)
  const prompt = useSupportAgent?.prompt ? await Template.load(useSupportAgent.prompt) : undefined

  // Build params (exact same pattern as main prompt flow at prompt.ts:205-215)
  return {
    params: {
      model: modelInfo.language,
      temperature: modelInfo.info.temperature
        ? useSupportAgent?.temperature ?? ProviderTransform.temperature(modelInfo.providerID, modelInfo.modelID)
        : undefined,
      topP: useSupportAgent?.topP ?? ProviderTransform.topP(modelInfo.providerID, modelInfo.modelID),
      providerOptions: {
        [modelInfo.providerID]: {
          ...ProviderTransform.options(modelInfo.providerID, modelInfo.modelID, sessionID || ""),
          ...modelInfo.info.options,
          ...useSupportAgent?.options,
        },
      },
    },
    modelInfo,
    prompt,
  }
}
