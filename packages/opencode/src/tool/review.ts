import z from "zod/v4"
import { streamText, tool, zodSchema, stepCountIs } from "ai"
import { buildSupportModelParams } from "../session/support-model-params"
import { Session } from "../session"
import { ReadTool } from "./read"
import { GrepTool } from "./grep"
import { GlobTool } from "./glob"
import { SymbolTool } from "./symbol"
import { Tool } from "./tool"
import type { ReviewMetadata } from "./metadata"
import type { ToolOutput } from "./metadata"
import { success } from "./metadata"
import { FileDiff } from "../util/file-diff"
import { extractAISDKErrorMessage } from "../util/error"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { processSessionStream, type ToolMetadataFns, type SessionStreamChunk } from "../session/stream"
import { Instance } from "../project/instance"

// @ts-ignore
import REVIEW_TEMPLATE from "./support/review.txt"

const MAX_REVIEW_STEPS = 15

/**
 * Create review agent that validates predicted changes against code requirements
 * This is designed to be called from within the edit tool's agent context
 */
export async function createReviewTool(
  filePath: string,
  lastSuccessfulEditRef: { fileDiff: FileDiff | null; summary: string },
  shadowContent: string,
  shadowContentRef: { newContent: string | null; approved: boolean },
  ctx: Tool.Context<any>,
): Promise<any> {
  return tool({
    description:
      "Review the predicted changes against shadow file requirements. Validates consistency between code changes and shadow updates. Call this after a successful predict and updateRequirements/createRequirements.",
    inputSchema: zodSchema(
      z.object({
        explanation: z.string().describe("Context and motivation for the code and shadow changes"),
      }),
    ),
    execute: async ({ explanation }): Promise<any> => {
      // Get the predicted FileDiff
      const fileDiff = lastSuccessfulEditRef.fileDiff
      if (!fileDiff) {
        throw new Error("No predicted content to review - call predict first")
      }

      ctx.metadata({
        metadata: {
          status: "Reviewing changes",
        },
      })

      // Create tools for review agent
      const reviewTools = {
        read: tool(await Tool.toAISDKTool(ReadTool, ctx, { omitParams: ["query"] })),
        grep: tool(await Tool.toAISDKTool(GrepTool, ctx)),
        glob: tool(await Tool.toAISDKTool(GlobTool, ctx)),
        symbol: tool(
          await Tool.toAISDKTool(SymbolTool, ctx, {
            omitParams: ["autorefresh"],
            defaultParams: { includeShadow: false },
          }),
        ),
        finalize: tool({
          description:
            "Finalize the review with validation results (the only way to complete review successfully). Provide your detailed review summary in natural text AFTER calling this tool.",
          inputSchema: zodSchema(
            z.object({
              passed: z.boolean().describe("Whether the review passed (true) or failed (false)"),
              summary: z.string().optional().describe("Fallback summary if you don't provide text after this call"),
              suggestions: z
                .string()
                .optional()
                .describe("Fallback suggestions if review failed and you don't provide text after this call"),
            }),
          ),
          execute: async ({
            passed,
            summary,
            suggestions,
          }): Promise<{
            output: ToolOutput
            metadata: { passed: boolean; fallbackSummary?: string; fallbackSuggestions?: string }
          }> => {
            return {
              output: success("Review finalized - provide your detailed review report now"),
              metadata: {
                passed,
                fallbackSummary: summary,
                fallbackSuggestions: suggestions,
              },
            }
          },
        }),
      }

      // Build review prompt using explicit "review" agent
      const reviewConfig = await buildSupportModelParams(
        "review",
        "review", // Explicitly use review agent, not ctx.agent
        REVIEW_TEMPLATE,
        ctx.sessionID,
        filePath,
      )
      const reviewParams = reviewConfig.params
      const systemMessages = reviewConfig.systemMessages
      const reviewModelInfo = reviewConfig.modelInfo

      // Use annotated content if available (shows full file with inline diff markers)
      // Otherwise fall back to separate diff + new content
      const contentMessage = fileDiff.annotated
        ? {
            role: "user" as const,
            content: `## Predicted File Changes (annotated)\n\nComplete file content with inline diff markers (- = removed, + = added, no marker = unchanged):\n\n\`\`\`\n${fileDiff.annotated}\n\`\`\``,
          }
        : {
            role: "user" as const,
            content: `## Predicted Code Changes\n\`\`\`diff\n${fileDiff.diff}\n\`\`\`\n\n## Predicted New File Content\n\`\`\`\n${fileDiff.newContent}\n\`\`\``,
          }

      // Build messages with code changes, shadow changes, and explanation
      const shadowMessage = shadowContentRef.newContent
        ? {
            role: "user" as const,
            content: `## Predicted Shadow File Changes\n\n### Old Shadow Content\n\`\`\`markdown\n${shadowContent || "(no shadow file exists)"}\n\`\`\`\n\n### New Shadow Content\n\`\`\`markdown\n${shadowContentRef.newContent}\n\`\`\``,
          }
        : shadowContent
          ? {
              role: "user" as const,
              content: `## Current Shadow File\n\`\`\`markdown\n${shadowContent}\n\`\`\`\n\nNo shadow updates were proposed.`,
            }
          : null

      const explanationMessage = {
        role: "user" as const,
        content: `## Context and Motivation\n\n${explanation}`,
      }

      const messages = [
        ...systemMessages.map((msg) => ({ role: "system" as const, content: msg })),
        contentMessage,
        ...(shadowMessage ? [shadowMessage] : []),
        explanationMessage,
      ]

      // Create a child session for review streaming
      const childSession = await Session.create(ctx.sessionID, `Reviewing ${filePath}`)

      // Call review model with tools
      const stream = (() => {
        try {
          return streamText({
            ...reviewParams,
            maxRetries: 0,
            messages,
            tools: reviewTools,
            abortSignal: ctx.abort,
            stopWhen: stepCountIs(MAX_REVIEW_STEPS),
          })
        } catch (err: any) {
          throw new Error(extractAISDKErrorMessage(err, "Review model API error"))
        }
      })()

      // Process stream to get finalize result
      let toolErrorMessage: string | undefined
      let finalizeMetadata: { passed: boolean; fallbackSummary?: string; fallbackSuggestions?: string } | undefined

      const assistantMessage: MessageV2.Assistant = {
        id: Identifier.ascending("message"),
        sessionID: childSession.id,
        system: systemMessages,
        mode: "review",
        cost: 0,
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        time: {
          created: Date.now(),
        },
        role: "assistant",
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        modelID: reviewModelInfo.modelID,
        providerID: reviewModelInfo.providerID,
      }
      await Session.updateMessage(assistantMessage)

      const toolcalls: Record<string, MessageV2.ToolPart> = {}
      const toolMeta: Record<string, ToolMetadataFns> = {}

      const abortSignal = ctx.abort as AbortSignal & { throwIfAborted?: () => void }
      if (!abortSignal.throwIfAborted) {
        abortSignal.throwIfAborted = () => {
          if (abortSignal.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError")
          }
        }
      }

      try {
        await processSessionStream({
          stream: stream as any,
          abort: abortSignal,
          message: assistantMessage,
          model: reviewModelInfo.info,
          toolcalls,
          toolMeta,
          snapshotRef: { value: undefined },
          blockedRef: { value: false },
          hooks: {
            async onToolResult({ chunk }: { chunk: Extract<SessionStreamChunk<unknown>, { type: "tool-result" }> }) {
              if (chunk.toolName !== "finalize") return
              try {
                const result = typeof chunk.output === "string" ? JSON.parse(chunk.output) : chunk.output
                // Extract finalize metadata (passed status and fallback text)
                finalizeMetadata = result.metadata as {
                  passed: boolean
                  fallbackSummary?: string
                  fallbackSuggestions?: string
                }
                ctx.metadata({
                  metadata: {
                    status: finalizeMetadata.passed ? "Review passed" : "Review failed",
                  },
                })
              } catch (err) {
                throw new Error("Review finalize tool returned malformed JSON response")
              }
            },
            onToolError(chunk: Extract<SessionStreamChunk<unknown>, { type: "tool-error" }>) {
              const error = chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
              toolErrorMessage = error.message
            },
          },
        })
      } catch (err: any) {
        throw new Error(extractAISDKErrorMessage(err, "Review streaming error"))
      } finally {
        if (!assistantMessage.time.completed) {
          assistantMessage.time.completed = Date.now()
          await Session.updateMessage(assistantMessage)
        }
        const parts = await Session.getParts(assistantMessage.id)
        for (const part of parts) {
          if (part.type !== "tool") continue
          const toolPart = part as MessageV2.ToolPart
          if (toolPart.state.status === "completed") continue
          if (toolPart.state.status === "error") continue
          if (toolPart.state.status === "pending") {
            await Session.updatePart({
              ...toolPart,
              state: {
                status: "error",
                input: {},
                error: "Tool execution aborted",
                time: {
                  start: Date.now(),
                  end: Date.now(),
                },
              },
            })
            continue
          }
          if (toolPart.state.status === "running") {
            await Session.updatePart({
              ...toolPart,
              state: {
                status: "error",
                input: toolPart.state.input,
                metadata: toolPart.state.metadata,
                error: "Tool execution aborted",
                time: {
                  start: toolPart.state.time.start,
                  end: Date.now(),
                },
              },
            })
          }
        }
      }

      if (!finalizeMetadata) {
        if (toolErrorMessage) {
          throw new Error(toolErrorMessage)
        }
        throw new Error("Review did not complete - finalize tool was not called")
      }

      // Collect assistant's text response from completed message parts
      let assistantText = ""
      const messageParts = await Session.getParts(assistantMessage.id)
      for (const part of messageParts) {
        if (part.type === "text") {
          const textPart = part as MessageV2.TextPart
          assistantText += textPart.text
        }
      }

      // Construct ReviewMetadata from assistant's text (preferred) or fallback to finalize params
      const summary = assistantText.trim() || finalizeMetadata.fallbackSummary || "Review completed"

      const result: { output: ToolOutput; metadata: ReviewMetadata } = {
        output: success(
          summary +
            (finalizeMetadata.fallbackSuggestions ? `\n\nSuggestions: ${finalizeMetadata.fallbackSuggestions}` : ""),
        ),
        metadata: {
          passed: finalizeMetadata.passed,
          summary,
          suggestions: finalizeMetadata.fallbackSuggestions,
        },
      }

      // Return the review result with proper structure
      return result
    },
  })
}
