import { generateText, type ModelMessage } from "ai"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { defer } from "../util/defer"
import { MessageV2 } from "./message-v2"
import { SystemPrompt } from "./system"
import { Bus } from "../bus"
import z from "zod/v4"
import type { ModelsDev } from "../provider/models"
import { SessionPrompt } from "./prompt"
import { Flag } from "../flag/flag"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { Agent } from "../agent/agent"
import { buildSupportModelParams } from "./support-model-params"
// Statically import the compact template (raw text)
// @ts-ignore: allow importing .txt as raw string
import COMPACT_TEMPLATE from "./prompt/compact.txt"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: Bus.event(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  export function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: ModelsDev.Model }) {
    if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) return false
    const context = input.model.limit.context
    if (context === 0) return false
    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
    const output = Math.min(input.model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    const usable = context - output
    return count > usable
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    if (Flag.OPENCODE_DISABLE_PRUNE) return
    log.info("pruning")
    const msgs = await Session.messages(input.sessionID)
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function run(input: { sessionID: string; providerID: string; modelID: string; agent: Agent.Info }) {
    await Session.update(input.sessionID, (draft) => {
      draft.time.compacting = Date.now()
    })
    await using _ = defer(async () => {
      await Session.update(input.sessionID, (draft) => {
        draft.time.compacting = undefined
      })
    })
    // Retrieve messages and apply V2 filtering for summaries
    const allMsgs = await Session.messages(input.sessionID).then(MessageV2.filterSummarized)
    const agentConfig = await Agent.get("compact")
    const rootModel = await Provider.getModel(input.providerID, input.modelID)
    const bufferCount = agentConfig?.options?.buffer ?? 3
    const lastSummaryIdx = allMsgs.findLastIndex((m) => m.info.role === "assistant" && !!m.info.summary)
    const newMsgs = lastSummaryIdx === -1 ? allMsgs.slice() : allMsgs.slice(lastSummaryIdx + 1)
    const toSummarize = bufferCount > 0 ? newMsgs.slice(0, Math.max(0, newMsgs.length - bufferCount)) : newMsgs

    // Build support params once (handles model selection + option merging)
    // Use calling agent (primary) if provided, otherwise fall back to default model
    const { params: supportParams, modelInfo, prompt } = await buildSupportModelParams(
      "compact",
      input.agent.name,
      COMPACT_TEMPLATE,
      input.sessionID,
    )

    // Build system context once and reuse for message + LLM call
    const system = [
      ...SystemPrompt.summarize(modelInfo.providerID),
      ...(await SystemPrompt.environment()),
      ...(await SystemPrompt.custom()),
    ]

    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      sessionID: input.sessionID,
      system,
      mode: "build",
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: input.modelID,
      providerID: rootModel.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant

    const convMsgs: ModelMessage[] = MessageV2.toModelMessage(toSummarize)
    // Build final messages: system context, conversation, then user instructions
    const systemMsgs: ModelMessage[] = system.map((text) => ({ role: "system", content: text }))
    const userMsg: ModelMessage = { role: "user", content: prompt }
    const generated = await generateText({
      ...supportParams,
      maxRetries: 10,
      messages: [...systemMsgs, ...convMsgs, userMsg],
    })
    const usageRes = Session.getUsage(modelInfo.info, generated.usage, generated.providerMetadata)
    msg.cost += usageRes.cost
    msg.tokens = usageRes.tokens
    msg.summary = true
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    const part = await Session.updatePart({
      type: "text",
      sessionID: input.sessionID,
      messageID: msg.id,
      id: Identifier.ascending("part"),
      text: generated.text,
      time: { start: Date.now(), end: Date.now() },
    })

    Bus.publish(Event.Compacted, {
      sessionID: input.sessionID,
    })

    return {
      info: msg,
      parts: [part],
    }
  }
}
