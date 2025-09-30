// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import z from "zod/v4"
import * as path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./edit.txt"
// Statically import template + examples
// @ts-ignore
import EDIT_TEMPLATE from "./support/edit.txt"
// @ts-ignore
import SNIPPET_EXAMPLE from "./support/snippet.txt"
// @ts-ignore
import DIFF_EXAMPLE from "./support/diff.txt"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Agent } from "../agent/agent"
import { Template } from "../util/template"
import { generateText } from "ai"
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

    // Retry loop that covers generation, application, and diagnostics write.
    let lastError = ""
    let summary = ""
    let outputDiff = ""

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Update status: preparing prompt
      ctx.metadata({
        metadata: {
          status: `Preparing prompt`,
          attempt,
        },
      })

      // Build system messages for this format
      currentFormat = attempt <= 2 ? currentFormat : Template.Format.Diff
      const example = currentFormat === Template.Format.Snippet ? SNIPPET_EXAMPLE : DIFF_EXAMPLE
      const { params: supportParams, prompt } = await buildSupportModelParams("edit", ctx.agent, ctx.sessionID)
      const baseTemplate = prompt ?? EDIT_TEMPLATE
      const substituted = await Template.substituteInputs(await Template.substitute(baseTemplate), {
        format: currentFormat,
        example,
      })
      const systemLines = substituted.split(/\n+/).filter((l) => l.trim().length > 0)
      const systemMsgs = systemLines.map((l) => ({ role: "system" as const, content: l }))

      // Assemble prompt, injecting prior error if retrying
      const messages = [...systemMsgs, ...fileMessages]
      if (attempt > 1 && lastError) {
        messages.push({ role: "user" as const, content: `Retry and avoid diagnostic error:\n${lastError}` })
      }
      messages.push(finalUser)

      // Update status: calling model
      ctx.metadata({
        metadata: {
          status: `Calling edit model`,
        },
      })

      // Call LLM once per attempt. Fail fast if the model call itself fails.
      let editGen
      try {
        editGen = await generateText({
          ...supportParams,
          maxRetries: 0,
          messages,
        })
      } catch (err: any) {
        // Fail fast on model errors (do not retry)
        throw new Error(`Edit model call failed: ${err?.message || String(err)}`)
      }

      const editOutput = editGen.text
      const { output, code } = parseEditOutput(editOutput)
      const preview = code.split("\n").slice(0, PREVIEW_LINES).join("\n").trim()

      // Update status: parsing output
      ctx.metadata({
        metadata: {
          status: `Parsing model output`,
        },
      })

      // Detect diff vs snippet for next iteration
      if (currentFormat != Template.Format.Diff) {
        const looksLikeDiff = /^\s*(diff\s|@@)/m.test(code)
        currentFormat = looksLikeDiff ? Template.Format.Diff : Template.Format.Snippet
      }

      // Update status: applying edit
      ctx.metadata({
        metadata: {
          status: `Applying edit`,
          format: currentFormat,
          diff: preview,
        },
      })

      const { contentNew, diff } =
        hasApplyModel && currentFormat === Template.Format.Snippet
          ? await applyEditOutput(code, output, ctx, filePath, contentOld)
          : await diffEditOutput(code, filePath, contentOld)

      outputDiff = diff || outputDiff

      if (contentOld.trimEnd() === contentNew.trimEnd()) {
        lastError =
          currentFormat === Template.Format.Snippet
            ? "Apply model failed to integrate the snippet"
            : "Diff did not result in any changes"
        ctx.metadata({
          metadata: {
            status: "Apply failed",
            error: lastError,
          },
        })
        continue
      }

      // This may throw a syntax-related exception or user rejection; if so, retry.
      try {
        const { diagnostics, absolutePath } = await handleDiagnosticsAndFileWrite(filePath, contentNew, {
          ctx,
          diff,
          type: "edit",
        })

        // Only block write if there are diagnostics for the target file
        if (diagnostics[absolutePath] && diagnostics[absolutePath].length > 0) {
          if (attempt >= MAX_RETRIES) {
            throw new Error(
              `Changes not applied due to persistent diagnostic errors:\n${Object.values(diagnostics).flat().map(LSP.Diagnostic.pretty).join("\n")}`,
            )
          }
          lastError = `Changes would introduce diagnostic errors:\n${Object.values(diagnostics).flat().map(LSP.Diagnostic.pretty).join("\n")}`
        } else {
          // Successful edit
          summary = output || "Edit applied successfully"
          lastError = ""
          break
        }
      } catch (err) {
        if (attempt >= MAX_RETRIES) {
          throw err
        } else if (err instanceof Permission.RejectedSyntaxError || err instanceof Permission.RejectedApproachError) {
          lastError = err.message
        } else {
          throw err
        }
      }
    }

    return {
      title: `Edited ${path.relative(Instance.directory, filePath)}`,
      metadata: {
        diagnostics: {},
        format: "diff",
        diff: outputDiff,
        error: lastError,
      },
      output: summary,
    }
  },
})
