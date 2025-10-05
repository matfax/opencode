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
import { applyEditOutput, diffEditOutput, handleDiagnosticsAndFileWrite } from "../util/apply"
import { extractCodeFromMarkdown, parseReportAndCodeSections } from "../util/extract"
import { LSP } from "../lsp"
import { Permission } from "../permission"
import { buildSupportModelParams } from "../session/support-model-params"
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
const MAX_RETRIES = 5
const PREVIEW_LINES = 20

// Define agentic tools for the edit model
function createEditAgentTools(
  contentOld: string,
  filePath: string,
  ctx: Tool.Context<any>,
  hasApplyModel: boolean,
  currentFormatRef: { format: Template.Format },
  lastSuccessfulEditRef: { content: string; diff: string; summary: string }
): Record<string, AITool> {
  return {
    predict: tool({
      description: "Predict the result of an edit (snippet or diff) by applying it to the original file content and checking LSP diagnostics",
      inputSchema: zodSchema(z.object({
        code: z.string().describe("The edit code (snippet or unified diff format)"),
        instruction: z.string().optional().describe("1-sentence instruction guiding the apply model how to integrate the changes (only used for Snippet format)"),
      })),
      execute: async ({ code, instruction }) => {
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
              status: "Running LSP diagnostics on applied edit",
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
            const allAffectedFiles = Object.keys(diagnosticsMap).filter(f => diagnosticsMap[f].length > 0)
            const otherFiles = allAffectedFiles.filter(f => f !== absolutePath)
            const errorMessage = otherFiles.length > 0
              ? `Changes would introduce diagnostic errors in target file:\n${diagnosticMessages}\n\nNote: Changes also affected other files (${otherFiles.join(", ")}), but these won't block the edit.`
              : `Changes would introduce diagnostic errors:\n${diagnosticMessages}`

            return {
              success: false,
              error: errorMessage,
              diagnostics: targetFileDiagnostics.map(LSP.Diagnostic.pretty),
            }
          }

          // Store successful edit for finalization
          lastSuccessfulEditRef.content = contentNew
          lastSuccessfulEditRef.diff = diff || ""
          lastSuccessfulEditRef.summary = instruction || "Edit applied"

          return {
            success: true,
            error: undefined,
            diagnostics: [],
          }
        } catch (err: any) {
          return {
            success: false,
            error: err?.message || String(err),
            diagnostics: [],
          }
        }
      },
    }),
    write: tool({
      description: "Write the last successful predict result to disk after permission checks. Only call this after predict returns success=true with no diagnostics.",
      inputSchema: zodSchema(z.object({
        summary: z.string().describe("Summary of changes made"),
        ignoreChecks: z.boolean().optional().describe("Skip validation that predict was called successfully (dangerous - only use if you know what you're doing)"),
      })),
      execute: async ({ summary, ignoreChecks }) => {
        try {
          if (!ignoreChecks && !lastSuccessfulEditRef.content) {
            return {
              success: false,
              error: "No successful prediction to write. Call predict first and ensure it succeeds.",
            }
          }

          ctx.metadata({
            metadata: {
              status: "Finalizing edit",
            },
          })

          // Write file with diagnostics and permission checks using the stored successful edit
          const result = await handleDiagnosticsAndFileWrite(filePath, lastSuccessfulEditRef.content, {
            ctx,
            diff: lastSuccessfulEditRef.diff,
            type: "edit",
          })

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
      description: "Reject the edit request if the instructions are wrong, incomplete, ambiguous, or cannot be executed properly",
      inputSchema: zodSchema(z.object({
        reason: z.string().describe("Detailed explanation of why the instructions are wrong, incomplete, or cannot be executed"),
      })),
      execute: async ({ reason }): Promise<{ rejected: true; reason: string }> => {
        throw new Error(`Edit rejected: ${reason}`)
      },
    }),
  }
}

export const EditTool = Tool.define("edit", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to modify"),
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
        maxRetries: MAX_RETRIES,
        previewLines: PREVIEW_LINES,
        attempt: 1,
      },
    })

    // Read the target file
    const file = Bun.file(filePath)
    const stats = await file.stat().catch(() => {})
    if (!stats) throw new Error(`File ${filePath} not found`)
    if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)

    const contentOld = await file.text()

    // Update status: resolving agents
    ctx.metadata({
      metadata: {
        status: "Resolving edit agents and models",
      },
    })

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
      // Update status: building context
      ctx.metadata({
        metadata: {
          status: "Building contextual messages",
        },
      })

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

    // Agentic tool-calling flow: model reviews and corrects its own output
    let summary = ""
    let outputDiff = ""
    let attempt = 1
    const currentFormatRef = { format: currentFormat }
    const lastSuccessfulEditRef = { content: "", diff: "", summary: "" }

    // Create tools for the edit agent
    const editTools = createEditAgentTools(contentOld, filePath, ctx, hasApplyModel, currentFormatRef, lastSuccessfulEditRef)

    // Update status: preparing agentic prompt
    ctx.metadata({
      metadata: {
        status: "Preparing agentic edit prompt",
      },
    })

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
        content: idx === systemMessages.length - 1
          ? await Template.substituteInputs(msg, { format: formatName })
          : msg
      }))
    )

    // Assemble messages
    const messages = [
      ...substitutedSystemMessages,
      ...fileMessages,
      finalUser,
    ]

    // Update status: calling agentic edit model
    ctx.metadata({
      metadata: {
        status: "Calling agentic edit model with tools",
      },
    })

    // Call model with tools (agentic mode) using streamText for better control
    const stream = streamText({
      ...supportParams,
      maxRetries: 0,
      messages,
      tools: editTools,
      stopWhen: stepCountIs(Math.max(MAX_RETRIES + 1, 2)),
    })

    // Process stream to collect tool results
    let finalized = false
    let lastApplyError: string | undefined

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
          } else if (chunk.toolName === "predict") {
            const result = typeof chunk.output === "string" ? JSON.parse(chunk.output) : chunk.output
            if (!result.success) {
              lastApplyError = result.error
              attempt = Math.min(MAX_RETRIES, attempt + 1)
              ctx.metadata({
                metadata: {
                  status: "Retrying edit after failed prediction",
                  attempt,
                  maxRetries: MAX_RETRIES,
                  error: result.error,
                },
              })
            }
          }
          break
      }
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
