// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import z from "zod/v4"
import * as path from "path"
import { Tool } from "./tool"
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
import { extractCodeFromMarkdown, parseReportAndCodeSections } from "../util/extract"
import { LSP } from "../lsp"
import { Permission } from "../permission"
import { buildSupportModelParams } from "../session/support-model-params"
import { ReadTool } from "./read"
import { GrepTool } from "./grep"
import { GlobTool } from "./glob"
import { SymbolTool } from "./symbol"
import { Shadow } from "../util/shadow"
import { createReviewTool } from "./review"
import { FileDiff } from "../util/file-diff"
// Re-export replace for existing tests that import from this module
export { replace } from "../util/apply"

// Bun runtime type declaration
declare const Bun: any

// Adapter to keep existing variable names when switching to shared parser
// @ts-ignore - kept for potential future non-agentic fallback
function parseEditOutput(output: string): { output: string; code: string } {
  const { report, codePart } = parseReportAndCodeSections(output)
  if (!report && !codePart) {
    const extractedCode = extractCodeFromMarkdown(output)
    if (!extractedCode || extractedCode.trim() === "") {
      throw new Error("No code found in model output: " + output)
    } else {
      return { output: "No summary provided", code: extractedCode }
    }
  } else if (!codePart || codePart.trim() === "") {
    throw new Error("Edit rejected: " + report)
  }
  return { output: report, code: codePart }
}

// Add retry configuration
const MAX_RETRIES = 20
const MAX_CONSECUTIVE_FAILURES = 5
const PREVIEW_LINES = 20

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
    symbol: tool(await Tool.toAISDKTool(SymbolTool, ctx, { omitParams: ["autorefresh"], defaultParams: { includeShadow: false } })),
    updateRequirements: tool({
      description:
        "Update shadow file requirements with a unified diff. Works for both existing shadows and iterative updates after createRequirements.",
      inputSchema: zodSchema(
        z.object({
          shadowDiff: z.string().describe("Unified diff for shadow file changes (old vs new shadow content)"),
        }),
      ),
      execute: async ({ shadowDiff }) => {
        try {
          // Apply diff to old shadow content to preview the result
          const newShadowContent = applyDiffToContent(shadowContent, shadowDiff)

          // Show user the predicted shadow changes
          ctx.metadata({
            metadata: {
              status: "Requesting permission to update requirements",
              shadowDiff,
              oldShadowContent: shadowContent || "(no shadow file exists)",
              newShadowContent,
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
              metadata: { filePath, shadowDiff },
              ...((hasShadowRemovals) && { strict: true }),
            })
          }

          // Store approved content in shared ref
          shadowContentRef.newContent = newShadowContent
          shadowContentRef.approved = true

          return {
            success: true,
            message: "Requirements updated and approved. Shadow file will be written after successful file write.",
          }
        } catch (err: any) {
          return {
            success: false,
            error: err?.message || String(err),
          }
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
              })
            )
            .optional()
            .describe("Symbols in the file with their purposes and requirements"),
        }),
      ),
      execute: async ({ motivation, symbols }) => {
        try {
          // Check if shadow already exists
          const shadowExists = await Shadow.exists(filePath)
          if (shadowExists) {
            return {
              success: false,
              error: "Shadow file already exists. Use updateRequirements instead to modify it.",
            }
          }

          // Create shadow content using template
          const newShadowContent = Shadow.createTemplate(filePath, motivation, symbols)

          // Show user the new shadow content
          ctx.metadata({
            metadata: {
              status: "Requesting permission to define requirements",
              newShadowContent,
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
              metadata: { filePath, newShadowContent },
            })
          }

          // Store approved content in shared ref
          shadowContentRef.newContent = newShadowContent
          shadowContentRef.approved = true

          return {
            success: true,
            message: "Requirements created. Shadow file will be written after successful file write.",
          }
        } catch (err: any) {
          return {
            success: false,
            error: err?.message || String(err),
          }
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
      execute: async ({ code, instruction }) => {
        // Check if max consecutive failures reached
        if (failureState.maxFailuresReached) {
          return {
            success: false,
            error: `Maximum consecutive failures (${MAX_CONSECUTIVE_FAILURES}) reached. Please use reject tool to explain what went wrong.`,
            diagnostics: [],
          }
        }

        try {
          // Detect format
          const looksLikeDiff = /^\s*(diff\s|@@)/m.test(code)
          currentFormatRef.format = looksLikeDiff ? Template.Format.Diff : Template.Format.Snippet

          ctx.metadata({
            metadata: {
              status: "Applying edit",
              format: currentFormatRef.format,
            },
          })

          // Apply the edit
          const { contentNew, diff } =
            hasApplyModel && currentFormatRef.format === Template.Format.Snippet
              ? await applyEditOutput(code, instruction || "Apply the provided changes", ctx, filePath, contentOld)
              : await diffEditOutput(code, filePath, contentOld)

          // Clear old diff and publish new one
          ctx.metadata({
            metadata: {
              diff: diff || "",
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

            return {
              success: false,
              error:
                currentFormatRef.format === Template.Format.Snippet
                  ? "Apply model failed to integrate the snippet - no changes resulted"
                  : "Diff did not result in any changes",
              diagnostics: [],
            }
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
            return {
              success: false,
              error: `LSP check failed: ${err instanceof Error ? err.message : String(err)}`,
              diagnostics: [],
            }
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

            return {
              success: false,
              error: errorMessage,
              diagnostics: targetFileDiagnostics.map(LSP.Diagnostic.pretty),
            }
          }

          // Store successful edit as FileDiff for finalization and reset failures
          lastSuccessfulEditRef.fileDiff = new FileDiff(contentOld, contentNew, diff || "", filePath)
          lastSuccessfulEditRef.summary = instruction || "Edit applied"

          // Reset failure counter on success
          failureState.consecutiveFailures = 0
          failureState.maxFailuresReached = false

          return {
            success: true,
            error: undefined,
            diagnostics: [],
          }
        } catch (err: any) {
          // Track failure
          failureState.consecutiveFailures++
          if (failureState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            failureState.maxFailuresReached = true
          }

          return {
            success: false,
            error: err?.message || String(err),
            diagnostics: [],
          }
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
              success: false,
              error: "No successful prediction to write. Call predict first and ensure it succeeds.",
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
            success: true,
            summary: summary || lastSuccessfulEditRef.summary,
            diff: result.diff,
          }
        } catch (err: any) {
          // Handle permission rejections and other errors
          if (err instanceof Permission.RejectedSyntaxError || err instanceof Permission.RejectedApproachError) {
            return {
              success: false,
              error: err.message,
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

export const EditTool = Tool.define("edit", {
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
  async execute(params, ctx) {
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
        previewLines: PREVIEW_LINES,
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
    const { params: supportParams, systemMessages } = await buildSupportModelParams(
      "edit",
      ctx.agent,
      EDIT_TEMPLATE,
      ctx.sessionID,
      filePath,
    )

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
      : [{ role: "user" as const, content: `## Code Requirements\n\nNo requirements documentation exists yet for this file. Use the createRequirements tool if you want to document this code.` }]
    const messages = [...substitutedSystemMessages, ...shadowMessage, ...fileMessages, finalUser]

    // Update status: calling agentic edit model
    ctx.metadata({
      metadata: {
        status: "Calling model",
      },
    })

    // Call model with tools (agentic mode) using streamText for better control
    let stream
    try {
      stream = streamText({
        ...supportParams,
        maxRetries: 0,
        messages,
        tools: editTools,
        stopWhen: stepCountIs(Math.max(MAX_RETRIES + 1, 2)),
      })
    } catch (err: any) {
      // Extract error details from AI SDK error
      const errorMessage = err?.responseBody
        ? `Edit model API error: ${JSON.stringify(err.responseBody)}`
        : err?.message || String(err)
      throw new Error(errorMessage)
    }

    // Process stream to collect tool results
    let finalized = false
    let lastApplyError: string | undefined

    try {
      for await (const chunk of stream.fullStream) {
      switch (chunk.type) {
        case "tool-result":
          if (chunk.toolName === "write") {
            const result = typeof chunk.output === "string" ? JSON.parse(chunk.output) : chunk.output
            if (!result.success) {
              throw new Error(`Edit write failed: ${result.error}`)
            }
            summary = result.summary || "Edit applied successfully"
            outputDiff = result.diff || ""
            finalized = true

            // Clear error metadata since write succeeded
            ctx.metadata({
              metadata: {
                error: "",
              },
              clear: true,
            })
          } else if (chunk.toolName === "review") {
            try {
              const result = typeof chunk.output === "string" ? JSON.parse(chunk.output) : chunk.output
              // Display review result metadata
              ctx.metadata({
                metadata: {
                  status: "Review " + (result.passed ? "passed" : "failed"),
                  reviewSummary: result.summary,
                  ...(result.suggestions && { reviewSuggestions: result.suggestions }),
                },
              })
            } catch (err) {
              ctx.metadata({
                metadata: {
                  status: "Review failed with invalid output",
                  error: "Review tool returned malformed response",
                },
              })
            }
          } else if (chunk.toolName === "predict") {
            try {
              const result = typeof chunk.output === "string" ? JSON.parse(chunk.output) : chunk.output
              if (!result.success) {
                lastApplyError = result.error
                ctx.metadata({
                  metadata: {
                    status: "Retrying after failed prediction",
                    attempt: failureState.consecutiveFailures + 1,
                    maxRetries: MAX_CONSECUTIVE_FAILURES,
                    error: result.error,
                  },
                })
              } else {
                // Reset attempt counter on success
                ctx.metadata({
                  metadata: {
                    attempt: 1,
                  },
                })
              }
            } catch (err) {
              lastApplyError = "Predict tool returned malformed response"
              ctx.metadata({
                metadata: {
                  status: "Prediction failed with invalid output",
                  error: lastApplyError,
                },
              })
            }
          }
          break
      }
    }
    } catch (err: any) {
      // Handle streaming errors during edit process
      const errorMessage = err?.responseBody
        ? `Edit streaming error: ${JSON.stringify(err.responseBody)}`
        : err?.message || String(err)
      throw new Error(errorMessage)
    }

    if (!finalized) {
      if (lastApplyError) {
        throw new Error(`Edit failed: ${lastApplyError}`)
      }
      throw new Error("Edit model did not finalize the edit")
    }

    return {
      title: `Edited ${path.relative(Instance.directory, filePath)}`,
      metadata: {
        format: "diff",
        diff: outputDiff,
      },
      output: summary,
    }
  },
})
