import type { StreamTextResult, Tool as AITool } from "ai"
import { mergeDeep } from "remeda"
import { Session } from "."
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Snapshot } from "../snapshot"
import { Permission } from "../permission"
import type { ModelsDev } from "../provider/models"

export type ToolMetadataFns = {
  key?: (args: unknown) => string | undefined
  enableRefresh?: (args: unknown) => boolean
  expireAfter?: (args: unknown) => number | undefined
}

export interface SessionStreamOptions<TResult, TTools extends Record<string, AITool> = Record<string, AITool>> {
  stream: StreamTextResult<TTools, TResult>
  abort: AbortSignal & { throwIfAborted?: () => void }
  message: MessageV2.Assistant
  model: ModelsDev.Model
  toolcalls: Record<string, MessageV2.ToolPart>
  toolMeta: Record<string, ToolMetadataFns>
  snapshotRef: { value?: string }
  blockedRef: { value: boolean }
  hooks?: {
    onChunk?: (chunk: SessionStreamChunk<TResult, TTools>) => void | Promise<void>
    onToolResult?: (data: {
      chunk: Extract<SessionStreamChunk<TResult, TTools>, { type: "tool-result" }>
      metadata: Record<string, unknown>
      output: string
    }) => void | Promise<void>
    onToolError?: (chunk: Extract<SessionStreamChunk<TResult, TTools>, { type: "tool-error" }>) => void | Promise<void>
    onUnhandled?: (chunk: SessionStreamChunk<TResult, TTools>) => void | Promise<void>
  }
}

export type SessionStreamChunk<
  TResult,
  TTools extends Record<string, AITool> = Record<string, AITool>,
> = (SessionStreamOptions<TResult, TTools>["stream"]["fullStream"] extends AsyncIterable<infer T> ? T : never) & {
  type: string
  [key: string]: unknown
}

export async function processSessionStream<TResult, TTools extends Record<string, AITool> = Record<string, AITool>>(
  options: SessionStreamOptions<TResult, TTools>,
) {
  const { stream, abort, message, model, toolcalls, toolMeta, snapshotRef, blockedRef, hooks } = options
  const textState: { value?: MessageV2.TextPart } = {}
  const reasoning = new Map<string, MessageV2.ReasoningPart>()
  const iterable = stream.fullStream as AsyncIterable<SessionStreamChunk<TResult, TTools>>

  for await (const chunk of iterable) {
    abort.throwIfAborted?.()
    if (hooks?.onChunk) await hooks.onChunk(chunk)

    switch (chunk.type) {
      case "start":
      case "tool-input-delta":
      case "tool-input-end":
        continue

      case "reasoning-start": {
        const id = typeof chunk.id === "string" ? chunk.id : undefined
        if (!id || reasoning.has(id)) continue
        const part: MessageV2.ReasoningPart = {
          id: Identifier.ascending("part"),
          messageID: message.id,
          sessionID: message.sessionID,
          type: "reasoning",
          text: "",
          time: {
            start: Date.now(),
          },
        }
        reasoning.set(id, part)
        continue
      }

      case "reasoning-delta": {
        const id = typeof chunk.id === "string" ? chunk.id : undefined
        if (!id) continue
        const part = reasoning.get(id)
        if (!part) continue
        const delta = typeof chunk.text === "string" ? chunk.text : ""
        part.text += delta
        if (chunk.providerMetadata) part.metadata = chunk.providerMetadata as Record<string, unknown>
        if (part.text) await Session.updatePart(part)
        continue
      }

      case "reasoning-end": {
        const id = typeof chunk.id === "string" ? chunk.id : undefined
        if (!id) continue
        const part = reasoning.get(id)
        if (!part) continue
        part.text = part.text.trimEnd()
        part.time = {
          ...part.time,
          end: Date.now(),
        }
        await Session.updatePart(part)
        reasoning.delete(id)
        continue
      }

      case "tool-input-start": {
        const callID = typeof chunk.id === "string" ? chunk.id : undefined
        const toolName = typeof chunk.toolName === "string" ? chunk.toolName : undefined
        if (!callID || !toolName) continue
        const part = await Session.updatePart({
          id: toolcalls[callID]?.id ?? Identifier.ascending("part"),
          messageID: message.id,
          sessionID: message.sessionID,
          type: "tool",
          tool: toolName,
          callID,
          state: {
            status: "pending",
          },
        })
        toolcalls[callID] = part as MessageV2.ToolPart
        continue
      }

      case "tool-call": {
        const callID = typeof chunk.toolCallId === "string" ? chunk.toolCallId : undefined
        const toolName = typeof chunk.toolName === "string" ? chunk.toolName : undefined
        if (!callID || !toolName) continue
        const match = toolcalls[callID]
        if (!match) continue
        const updated = await Session.updatePart({
          ...match,
          tool: toolName,
          state: {
            status: "running",
            input: (chunk.input ?? {}) as Record<string, unknown>,
            metadata: match.state.metadata || {},
            time: {
              start: Date.now(),
            },
          },
        })
        toolcalls[callID] = updated as MessageV2.ToolPart
        continue
      }

      case "tool-result": {
        const callID = typeof chunk.toolCallId === "string" ? chunk.toolCallId : undefined
        if (!callID) continue
        const match = toolcalls[callID]
        if (!match || match.state.status !== "running") continue

        const history = await Session.messages(match.sessionID)
        let currentMetadata = match.state.metadata || {}
        for (const m of history) {
          const existing = m.parts.find((p) => p.id === match.id)
          if (!existing || existing.type !== "tool") continue
          const existingState = (existing as MessageV2.ToolPart).state
          if (existingState.metadata) currentMetadata = existingState.metadata
          break
        }

        const toolOutput = (chunk.output ?? {}) as {
          metadata?: Record<string, unknown>
          title?: string
          output?: unknown
        }
        let metadata = mergeDeep(currentMetadata, toolOutput.metadata || {}) as Record<string, unknown>
        const metaFns = toolMeta[match.tool]
        let key: string | undefined
        if (metaFns?.key) {
          try {
            key = metaFns.key(chunk.input)
          } catch {}
        }
        if (key) {
          const priorMessages = await Session.messages(match.sessionID)
          for (const m of priorMessages) {
            for (const part of m.parts) {
              if (part.id === match.id || part.type !== "tool") continue
              const toolPart = part as MessageV2.ToolPart
              const partState = toolPart.state
              const partMeta = partState.metadata || {}
              const storedKey = (partMeta as Record<string, unknown>)["_key"]
              if (storedKey !== key) continue
              if (partState.status === "completed" && !partState.time.compacted) {
                await Session.updatePart({
                  ...toolPart,
                  state: {
                    ...partState,
                    output: "[Superseded]",
                    metadata: { ...partMeta, _supersededBy: match.id },
                  },
                })
              }
            }
          }
          metadata = { ...metadata, _key: key }
        }
        if (key && metaFns?.enableRefresh?.(chunk.input)) {
          metadata = {
            ...metadata,
            _fresh: { enabled: true, key, lastRun: Date.now(), failures: 0, mode: "auto" },
          }
        }
        const normalizedOutput =
          typeof toolOutput.output === "string" ? toolOutput.output : JSON.stringify(toolOutput.output ?? "")
        await Session.updatePart({
          ...match,
          state: {
            status: "completed",
            input: (chunk.input ?? {}) as Record<string, unknown>,
            output: normalizedOutput,
            metadata,
            title: toolOutput.title ?? match.state.title ?? "",
            time: {
              start: match.state.time.start,
              end: Date.now(),
            },
          },
        })
        delete toolcalls[callID]
        if (hooks?.onToolResult) {
          await hooks.onToolResult({
            chunk: chunk as Extract<SessionStreamChunk<TResult, TTools>, { type: "tool-result" }>,
            metadata,
            output: normalizedOutput,
          })
        }
        continue
      }

      case "tool-error": {
        const callID = typeof chunk.toolCallId === "string" ? chunk.toolCallId : undefined
        if (!callID) continue
        const match = toolcalls[callID]
        if (!match || match.state.status !== "running") continue
        const error = chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
        await Session.updatePart({
          ...match,
          state: {
            status: "error",
            input: (chunk.input ?? {}) as Record<string, unknown>,
            error: error.toString(),
            metadata: undefined,
            time: {
              start: match.state.time.start,
              end: Date.now(),
            },
          },
        })
        if (error instanceof Permission.RejectedError) {
          blockedRef.value = true
        }
        delete toolcalls[callID]
        if (hooks?.onToolError) {
          await hooks.onToolError(chunk as Extract<SessionStreamChunk<TResult, TTools>, { type: "tool-error" }>)
        }
        continue
      }

      case "error": {
        throw (chunk.error as Error) ?? new Error("Unknown stream error")
      }

      case "start-step": {
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: message.id,
          sessionID: message.sessionID,
          type: "step-start",
        })
        snapshotRef.value = await Snapshot.track()
        continue
      }

      case "finish-step": {
        const usage = Session.getUsage(model, chunk.usage, chunk.providerMetadata)
        message.cost += usage.cost
        message.tokens = usage.tokens
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: message.id,
          sessionID: message.sessionID,
          type: "step-finish",
          tokens: usage.tokens,
          cost: usage.cost,
        })
        await Session.updateMessage(message)
        if (snapshotRef.value) {
          const patch = await Snapshot.patch(snapshotRef.value)
          if (patch.files.length) {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: message.id,
              sessionID: message.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          snapshotRef.value = undefined
        }
        continue
      }

      case "text-start": {
        textState.value = {
          id: Identifier.ascending("part"),
          messageID: message.id,
          sessionID: message.sessionID,
          type: "text",
          text: "",
          time: {
            start: Date.now(),
          },
        }
        continue
      }

      case "text-delta": {
        if (!textState.value) continue
        const delta = typeof chunk.text === "string" ? chunk.text : ""
        textState.value.text += delta
        if (textState.value.text) await Session.updatePart(textState.value)
        continue
      }

      case "text-end": {
        if (!textState.value) continue
        textState.value.text = textState.value.text.trimEnd()
        textState.value.time = {
          start: textState.value.time?.start ?? Date.now(),
          end: Date.now(),
        }
        await Session.updatePart(textState.value)
        textState.value = undefined
        continue
      }

      case "finish": {
        message.time.completed = Date.now()
        await Session.updateMessage(message)
        continue
      }

      default: {
        if (hooks?.onUnhandled) await hooks.onUnhandled(chunk)
      }
    }
  }
}
