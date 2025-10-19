// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import z from "zod/v4"
import * as path from "path"
import { Tool } from "./tool"
import type {
  EditMetadata,
  PredictMetadata,
  CreateRequirementsMetadata,
  UpdateRequirementsMetadata,
  Content,
  ToolOutput,
} from "./metadata"
import { success, serializeContent } from "./metadata"
import DESCRIPTION from "./edit.txt"
// Statically import template
// @ts-ignore
import EDIT_TEMPLATE from "./support/edit.txt"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Agent } from "../agent/agent"
import { Template } from "../util/template"
import { streamText, tool, zodSchema, stepCountIs, type Tool as AITool } from "ai"
// Shared apply & utility functions
import { applyEditOutput, diffEditOutput, handleDiagnosticsAndFileWrite, applyDiffToContent } from "../util/apply"
import { LSP } from "../lsp"
import { Permission } from "../permission"
import { buildSupportModelParams } from "../session/support-model-params"
import { Session } from "../session"
import { ReadTool } from "./read"
import { GrepTool } from "./grep"
import { GlobTool } from "./glob"
import { SymbolTool } from "./symbol"
import { Shadow } from "../util/shadow"
import { createReviewTool } from "./review"
import { FileDiff } from "../util/file-diff"
import { extractAISDKErrorMessage } from "../util/error"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { processSessionStream, type ToolMetadataFns, type SessionStreamChunk } from "../session/stream"
// Re-export replace for existing tests that import from this module
export { replace } from "../util/apply"

// Bun runtime type declaration
declare const Bun: any

// Add retry configuration
const MAX_RETRIES = 20
const MAX_CONSECUTIVE_FAILURES = 5

// Define agentic tools for the edit model
async function createEditAgentTools(
  contentOld: string,
  filePath: string,
  ctx: Tool.Context<any>,
  hasApplyModel: boolean,
  currentFormatRef: { format: Template.Format },
  lastSuccessfulEditRef: { fileDiff: FileDiff | null; summary: string },
  failureState: { consecutiveFailures: number; maxFailuresReached: boolean },
  shadowContent: string,
  shadowContentRef: { newContent: string | null; approved: boolean },
): Promise<Record<string, AITool>> {
  return {
    // Use adapter to convert existing tools, omitting 'query' param from read tool
    read: tool(await Tool.toAISDKTool(ReadTool, ctx, { omitParams: ["query"] })),
    grep: tool(await Tool.toAISDKTool(GrepTool, ctx)),
    glob: tool(await Tool.toAISDKTool(GlobTool, ctx)),
    symbol: tool(
      await Tool.toAISDKTool(SymbolTool, ctx, { omitParams: ["autorefresh"], defaultParams: { includeShadow: false } }),
    ),
    updateRequirements: tool({
      description:
        "Update shadow file requirements with a unified diff. Works for both existing shadows and iterative updates after createRequirements.",
      inputSchema: zodSchema(
        z.object({
          shadowDiff: z.string().describe("Unified diff for shadow file changes (old vs new shadow content)"),
        }),
      ),
      execute: async ({
        shadowDiff,
      }): Promise<{
        output: ToolOutput
        metadata: UpdateRequirementsMetadata
      }> => {
        try {
          // Apply diff to old shadow content to preview the result
          const newShadowContent = applyDiffToContent(shadowContent, shadowDiff)

          // Show user the predicted shadow changes
          ctx.metadata({
            metadata: {
              status: "Requesting permission to update requirements",
              shadowDiff: { diff: shadowDiff },
            },
          })

          // Check if diff removes requirements (triggers strict permission)
          const hasShadowRemovals = Shadow.hasRemovals(shadowDiff)

          // Get agent for permission check
          const agent = await Agent.get(ctx.agent)

          // Run permission check if needed
          if (agent.permission.edit === "ask" || hasShadowRemovals) {
            await Permission.ask({
              type: "edit",
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              callID: ctx.callID,
              title: `Update requirements for: ${filePath}${hasShadowRemovals ? " (requirements removed)" : ""}`,
              ...(hasShadowRemovals && { strict: true }),
            })
          }

          // Store approved content in shared ref
          shadowContentRef.newContent = newShadowContent
          shadowContentRef.approved = true

          const result: { output: ToolOutput; metadata: UpdateRequirementsMetadata } = {
            output: success(
              "Requirements updated and approved. Shadow file will be written after successful file write.",
            ),
            metadata: {
              shadowDiff: { diff: shadowDiff },
            },
          }
          return result
        } catch (err: any) {
          throw err instanceof Error ? err : new Error(String(err))
        }
      },
    }),
    createRequirements: tool({
      description: "Create shadow file for new code file. Use this for initial shadow creation.",
      inputSchema: zodSchema(
        z.object({
          motivation: z.string().describe("Brief description of file purpose and goals"),
          symbols: z
            .array(
              z.object({
                name: z.string().describe("Symbol name (class, function, interface, enum - no variables)"),
                purpose: z.string().describe("Why this symbol exists and what it does"),
                requirements: z.array(z.string()).optional().describe("Specific requirements for this symbol"),
              }),
            )
            .optional()
            .describe("Symbols in the file with their purposes and requirements"),
        }),
      ),
      execute: async ({
        motivation,
        symbols,
      }): Promise<{
        output: ToolOutput
        metadata: CreateRequirementsMetadata
      }> => {
        try {
          // Check if shadow already exists
          const shadowExists = await Shadow.exists(filePath)
          if (shadowExists) {
            const errorResult: { output: ToolOutput; metadata: CreateRequirementsMetadata } = {
              output: new Error("Shadow file already exists. Use updateRequirements instead to modify it."),
              metadata: {
                shadowDiff: { diff: "" },
              },
            }
            return errorResult
          }

          // Create shadow content using template
          const newShadowContent = Shadow.createTemplate(filePath, motivation, symbols)

          // Show user the new shadow content
          ctx.metadata({
            metadata: {
              status: "Requesting permission to define requirements",
              shadowDiff: { diff: newShadowContent }, // For creation, the "diff" is just the new content
            },
          })

          // Get agent for permission check
          const agent = await Agent.get(ctx.agent)

          // Run permission check (non-strict for new shadow creation)
          if (agent.permission.edit === "ask") {
            await Permission.ask({
              type: "edit",
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              callID: ctx.callID,
              title: `Create shadow file for: ${filePath}`,
            })
          }

          // Store approved content in shared ref
          shadowContentRef.newContent = newShadowContent
          shadowContentRef.approved = true

          const result: { output: ToolOutput; metadata: CreateRequirementsMetadata } = {
            output: success("Requirements created. Shadow file will be written after successful file write."),
            metadata: {
              shadowDiff: { diff: newShadowContent },
            },
          }
          return result
        } catch (err: any) {
          throw err instanceof Error ? err : new Error(String(err))
        }
      },
    }),
    review: await createReviewTool(filePath, lastSuccessfulEditRef, shadowContent, shadowContentRef, ctx),
    predict: tool({
      description:
        "Predict the result of an edit (snippet or diff) by applying it to the original file content and checking LSP diagnostics",
      inputSchema: zodSchema(
        z.object({
          code: z.string().describe("The edit code (snippet or unified diff format)"),
          instruction: z
            .string()
            .optional()
            .describe(
              "1-sentence instruction guiding the apply model how to integrate the changes (only used for Snippet format)",
            ),
        }),
      ),
      execute: async ({
        code,
        instruction,
      }): Promise<{
        output: ToolOutput
        metadata: PredictMetadata
      }> => {
        // Check if max consecutive failures reached
        if (failureState.maxFailuresReached) {
          const result: { output: ToolOutput; metadata: PredictMetadata } = {
            output: new Error(
              `Maximum consecutive failures (${MAX_CONSECUTIVE_FAILURES}) reached. Please use reject tool to explain what went wrong.`,
            ),
            metadata: {},
          }
          return result
        }

        try {
          // Detect format
          const looksLikeDiff = /^\s*(diff\s|@@)/m.test(code)
          currentFormatRef.format = looksLikeDiff ? Template.Format.Diff : Template.Format.Snippet

          ctx.metadata({
            metadata: {
              status: "Applying edit",
              instruction,
            },
          })

          // Apply the edit
          const { contentNew, diff } =
            hasApplyModel && currentFormatRef.format === Template.Format.Snippet
              ? await applyEditOutput(code, instruction || "Apply the provided changes", ctx, filePath, contentOld)
              : await diffEditOutput(code, filePath, contentOld)

          // Create typed Content object based on format
          const content: Content = looksLikeDiff
            ? { diff: diff || "" }
            : { content: code, language: Filesystem.detectLanguage(filePath) }

          // Clear old content and publish new one
          ctx.metadata({
            metadata: {
              content,
            },
            clear: true,
          })

          // Check if any changes occurred
          if (contentOld.trimEnd() === contentNew.trimEnd()) {
            // Track failure
            failureState.consecutiveFailures++
            if (failureState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              failureState.maxFailuresReached = true
            }

            const result: { output: ToolOutput; metadata: PredictMetadata } = {
              output: new Error(
                currentFormatRef.format === Template.Format.Snippet
                  ? "Apply model failed to integrate the snippet - no changes resulted"
                  : "Diff did not result in any changes",
              ),
              metadata: { content, fullContent: serializeContent(content) },
            }
            return result
          }

          // Run LSP diagnostics check on the new content
          ctx.metadata({
            metadata: {
              status: "Running diagnostics",
            },
          })

          const absolutePath = path.resolve(filePath)
          let diagnosticsMap: Record<string, any[]>
          try {
            diagnosticsMap = await LSP.pushVirtualContent(absolutePath, contentNew)
            // Revert virtual content immediately after checking
            try {
              await LSP.revertVirtualContent(absolutePath)
            } catch {}
          } catch (err) {
            try {
              await LSP.revertVirtualContent(absolutePath)
            } catch {}
            const result: { output: ToolOutput; metadata: PredictMetadata } = {
              output: new Error(`LSP check failed: ${err instanceof Error ? err.message : String(err)}`),
              metadata: { content, fullContent: serializeContent(content) },
            }
            return result
          }

          // Always clear diagnostics first, then set new ones if any
          ctx.metadata({
            metadata: {
              diagnostics: diagnosticsMap,
            },
            clear: true,
          })

          // Only fail if the TARGET file has diagnostic errors
          const targetFileDiagnostics = diagnosticsMap[absolutePath] || []
          if (targetFileDiagnostics.length > 0) {
            const diagnosticMessages = targetFileDiagnostics.map(LSP.Diagnostic.pretty).join("\n")

            // Inform model about all affected files
            const allAffectedFiles = Object.keys(diagnosticsMap).filter((f) => diagnosticsMap[f].length > 0)
            const otherFiles = allAffectedFiles.filter((f) => f !== absolutePath)
            const errorMessage =
              otherFiles.length > 0
                ? `Changes would introduce diagnostic errors in target file:\n${diagnosticMessages}\n\nNote: Changes also affected other files (${otherFiles.join(", ")}), but these won't block the edit.`
                : `Changes would introduce diagnostic errors:\n${diagnosticMessages}`

            // Track failure
            failureState.consecutiveFailures++
            if (failureState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              failureState.maxFailuresReached = true
            }

            const result: { output: ToolOutput; metadata: PredictMetadata } = {
              output: new Error(errorMessage),
              metadata: {
                content,
                diagnostics: diagnosticsMap,
                fullContent: serializeContent(content),
              },
            }
            return result
          }

          // Store successful edit as FileDiff for finalization and reset failures
          lastSuccessfulEditRef.fileDiff = new FileDiff(contentOld, contentNew, diff || "", filePath)
          lastSuccessfulEditRef.summary = instruction || "Edit applied"

          // Reset failure counter on success
          failureState.consecutiveFailures = 0
          failureState.maxFailuresReached = false

          const successResult: { output: ToolOutput; metadata: PredictMetadata } = {
            output: success("Edit prediction successful"),
            metadata: {
              content,
              diagnostics: diagnosticsMap,
              fullContent: serializeContent(content),
            },
          }
          return successResult
        } catch (err: any) {
          // Track failure
          failureState.consecutiveFailures++
          if (failureState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            failureState.maxFailuresReached = true
          }

          const errorResult: { output: ToolOutput; metadata: PredictMetadata } = {
            output: err instanceof Error ? err : new Error(String(err)),
            metadata: {},
          }
          return errorResult
        }
      },
    }),
    write: tool({
      description:
        "Write the last successful predict result to disk after permission checks. Only call this after predict returns success=true with no diagnostics.",
      inputSchema: zodSchema(
        z.object({
          summary: z.string().describe("Summary of changes made"),
          ignoreChecks: z
            .boolean()
            .optional()
            .describe(
              "Skip validation that predict was called successfully (dangerous - only use if you know what you're doing)",
            ),
        }),
      ),
      execute: async ({ summary, ignoreChecks }) => {
        try {
          if (!ignoreChecks && !lastSuccessfulEditRef.fileDiff) {
            return {
              output: new Error("No successful prediction to write. Call predict first and ensure it succeeds."),
              metadata: {},
            }
          }

          // Write file with diagnostics and permission checks using the stored successful edit
          const result = await handleDiagnosticsAndFileWrite(filePath, lastSuccessfulEditRef.fileDiff!.newContent, {
            ctx,
            diff: lastSuccessfulEditRef.fileDiff!.diff,
            type: "edit",
          })

          // Write shadow file if it was updated and approved
          if (shadowContentRef.approved && shadowContentRef.newContent) {
            ctx.metadata({
              metadata: {
                status: "Writing shadow file",
              },
            })
            await Shadow.write(filePath, shadowContentRef.newContent)
          }

          return {
            output: success(summary || lastSuccessfulEditRef.summary),
            metadata: {
              content: { diff: result.diff },
            },
          }
        } catch (err: any) {
          // Handle permission rejections and other errors
          if (err instanceof Permission.RejectedSyntaxError || err instanceof Permission.RejectedApproachError) {
            return {
              output: new Error(err.message),
              metadata: {},
            }
          }
          throw err
        }
      },
    }),
    reject: tool({
      description:
        "Reject the edit request if the instructions are wrong, incomplete, ambiguous, or cannot be executed properly",
      inputSchema: zodSchema(
        z.object({
          reason: z
            .string()
            .describe("Detailed explanation of why the instructions are wrong, incomplete, or cannot be executed"),
        }),
      ),
      execute: async ({ reason }): Promise<{ rejected: true; reason: string }> => {
        throw new Error(`Edit rejected: ${reason}`)
      },
    }),
  }
}

export const EditTool = Tool.define<
  z.ZodObject<{
    filePath: z.ZodString
    instructions: z.ZodString
    relevantFiles: z.ZodOptional<z.ZodArray<z.ZodString>>
  }>,
  EditMetadata
>("edit", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("Path to the file to modify"),
    instructions: z.string().describe("Natural language instructions describing what changes to make"),
    relevantFiles: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of relevant files for context to understand how edits should integrate with the broader codebase",
      ),
  }),
  async execute(params, ctx: Tool.Context<EditMetadata>) {
    if (!params.filePath) {
      throw new Error("filePath is required")
    }

    if (!params.instructions || params.instructions.trim() === "") {
      throw new Error("instructions are required")
    }

    const filePath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    if (!Filesystem.contains(Instance.directory, filePath)) {
      throw new Error(`File ${filePath} is not in the current working directory`)
    }

    // Update status: reading file
    ctx.metadata({
      metadata: {
        status: "Reading target file",
        maxRetries: MAX_CONSECUTIVE_FAILURES,
      },
    })

    // Read the target file
    const file = Bun.file(filePath)
    const stats = await file.stat().catch(() => {})
    if (!stats) throw new Error(`File ${filePath} not found`)
    if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)

    const contentOld = await file.text()

    // Determine initial format preference based on apply agent
    const applyAgentForFormat = await Agent.get("apply")
    const hasApplyModel = applyAgentForFormat?.model !== undefined
    let currentFormat = hasApplyModel ? Template.Format.Snippet : Template.Format.Diff

    // Build contextual messages (unchanged across retries)
    const fileMessages = [] as { role: "user"; content: string }[]
    fileMessages.push({
      role: "user",
      content: `// File: ${path.relative(Instance.directory, filePath)}\n${contentOld}`,
    })
    if (params.relevantFiles) {
      for (const rel of params.relevantFiles) {
        try {
          const abs = path.isAbsolute(rel) ? rel : path.join(Instance.directory, rel)
          if (!Filesystem.contains(Instance.directory, abs)) continue
          const c = await Bun.file(abs).text()
          fileMessages.push({ role: "user", content: `// File: ${path.relative(Instance.directory, abs)}\n${c}` })
        } catch {}
      }
    }
    const finalUser = { role: "user" as const, content: `## Instructions\n${params.instructions}` }

    // Read shadow file if exists
    ctx.metadata({
      metadata: {
        status: "Reading shadow file",
      },
    })
    const shadowContent = await Shadow.read(filePath)

    // Agentic tool-calling flow: model reviews and corrects its own output
    let summary = ""
    let outputDiff = ""
    const currentFormatRef = { format: currentFormat }
    const lastSuccessfulEditRef = { fileDiff: null as FileDiff | null, summary: "" }
    const failureState = { consecutiveFailures: 0, maxFailuresReached: false }
    const shadowContentRef = { newContent: null as string | null, approved: false }

    // Create tools for the edit agent
    const editTools = await createEditAgentTools(
      contentOld,
      filePath,
      ctx,
      hasApplyModel,
      currentFormatRef,
      lastSuccessfulEditRef,
      failureState,
      shadowContent,
      shadowContentRef,
    )

    // Build system prompt using the template
    const supportConfig = await buildSupportModelParams("edit", ctx.agent, EDIT_TEMPLATE, ctx.sessionID, filePath)
    const supportParams = supportConfig.params
    const systemMessages = supportConfig.systemMessages
    const supportModelInfo = supportConfig.modelInfo

    // Substitute {input:format} in the last system message (main prompt, not spoof header)
    const formatName = currentFormat === Template.Format.Snippet ? "Snippet" : "Diff"
    const substitutedSystemMessages = await Promise.all(
      systemMessages.map(async (msg, idx) => ({
        role: "system" as const,
        content: idx === systemMessages.length - 1 ? await Template.substituteInputs(msg, { format: formatName }) : msg,
      })),
    )

    // Assemble messages, injecting shadow content if it exists
    const shadowMessage = shadowContent
      ? [{ role: "user" as const, content: `## Code Requirements\n\`\`\`markdown\n${shadowContent}\n\`\`\`` }]
      : [
          {
            role: "user" as const,
            content: `## Code Requirements\n\nNo requirements documentation exists yet for this file. Use the createRequirements tool if you want to document this code.`,
          },
        ]
    const messages = [...substitutedSystemMessages, ...shadowMessage, ...fileMessages, finalUser]

    // Update status: calling agentic edit model
    ctx.metadata({
      metadata: {
        status: "Calling model",
      },
    })

    // Create a child session for edit streaming
    const childSession = await Session.create(ctx.sessionID, `Editing ${path.relative(Instance.directory, filePath)}`)

    // Call model with tools (agentic mode) using streamText for better control
    let stream
    try {
      stream = streamText({
        ...supportParams,
        maxRetries: 0,
        messages,
        tools: editTools,
        abortSignal: ctx.abort,
        stopWhen: stepCountIs(Math.max(MAX_RETRIES + 1, 2)),
      })
    } catch (err: any) {
      throw new Error(extractAISDKErrorMessage(err, "Edit model API error"))
    }

    const assistantMessage: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      sessionID: childSession.id,
      system: systemMessages,
      mode: "edit",
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
      modelID: supportModelInfo.modelID,
      providerID: supportModelInfo.providerID,
    }
    await Session.updateMessage(assistantMessage)

    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    const toolMeta: Record<string, ToolMetadataFns> = {}

    // Process stream to collect tool results
    let finalized = false
    let lastApplyError: string | undefined

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
        stream,
        abort: abortSignal,
        message: assistantMessage,
        model: supportModelInfo.info,
        toolcalls,
        toolMeta,
        snapshotRef: { value: undefined },
        blockedRef: { value: false },
        hooks: {
          async onToolResult({ chunk }: { chunk: Extract<SessionStreamChunk<unknown>, { type: "tool-result" }> }) {
            if (chunk.toolName === "write") {
              const result = typeof chunk.output === "string" ? JSON.parse(chunk.output) : chunk.output
              // Check if write succeeded by checking for content in metadata
              if (!result.metadata?.content) {
                throw new Error(`Edit write failed: ${result.output}`)
              }
              summary = result.output || "Edit applied successfully"
              outputDiff = result.metadata.content.diff || ""
              finalized = true
              return
            }

            if (chunk.toolName === "review") {
              try {
                const result = typeof chunk.output === "string" ? JSON.parse(chunk.output) : chunk.output
                // Review result structure depends on review.ts implementation
                const reviewData = result.metadata || result
                ctx.metadata({
                  metadata: {
                    status: "Review " + (reviewData.passed ? "passed" : "failed"),
                    reviewSummary: reviewData.summary,
                    ...(reviewData.suggestions && { reviewSuggestions: reviewData.suggestions }),
                  },
                })
              } catch (err) {
                ctx.metadata({
                  metadata: {
                    status: "Review failed with invalid output",
                  },
                })
              }
              return
            }

            if (chunk.toolName === "predict") {
              try {
                const result = typeof chunk.output === "string" ? JSON.parse(chunk.output) : chunk.output
                // Check if prediction failed - look for diagnostics indicating failure
                const hasErrors =
                  result.metadata?.diagnostics &&
                  Object.values(result.metadata.diagnostics).some((diags: any) => diags && diags.length > 0)
                // Also check if the output message indicates failure
                const isFailureMessage =
                  result.output &&
                  (result.output.includes("failed") ||
                    result.output.includes("error") ||
                    result.output.includes("did not result in any changes"))

                if (hasErrors || isFailureMessage) {
                  lastApplyError = result.output
                  ctx.metadata({
                    metadata: {
                      status: "Retrying after failed prediction",
                      attempt: failureState.consecutiveFailures + 1,
                      maxRetries: MAX_CONSECUTIVE_FAILURES,
                    },
                  })
                  return
                }
                ctx.metadata({
                  metadata: {
                    attempt: 1,
                  },
                })
              } catch (err) {
                lastApplyError = "Predict tool returned malformed response"
                ctx.metadata({
                  metadata: {
                    status: "Prediction failed with invalid output",
                  },
                })
              }
            }
          },
          onToolError(chunk: Extract<SessionStreamChunk<unknown>, { type: "tool-error" }>) {
            const error = chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
            lastApplyError = error.message
          },
        },
      })
    } catch (err: any) {
      throw new Error(extractAISDKErrorMessage(err, "Edit streaming error"))
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

    if (!finalized) {
      if (lastApplyError) {
        throw new Error(`Edit failed: ${lastApplyError}`)
      }
      throw new Error("Edit model did not finalize the edit")
    }

    const editResult: { title: string; metadata: EditMetadata; output: ToolOutput; childSessionID: string } = {
      title: `Edited ${path.relative(Instance.directory, filePath)}`,
      metadata: {
        diff: outputDiff,
        fullContent: outputDiff,
      },
      output: success(summary),
      childSessionID: childSession.id,
    }
    return editResult
  },
})
