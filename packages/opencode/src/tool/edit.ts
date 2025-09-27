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
import { Provider } from "../provider/provider"
import { Template } from "../util/template"
import { generateText } from "ai"
// Shared apply & utility functions
import { applyEditOutput, diffEditOutput, handleDiagnosticsAndFileWrite, SyntaxErrorAfterEdit } from "../util/apply"
import { extractCodeFromMarkdown, parseReportAndCodeSections } from "../util/extract"
// Re-export replace for existing tests that import from this module
export { replace } from "../util/apply"

// Bun runtime type declaration
declare const Bun: any

// Adapter to keep existing variable names when switching to shared parser
function parseEditOutput(output: string): { summary: string; code: string } {
  const { report, codePart } = parseReportAndCodeSections(output)
  if (!report && !codePart) {
    const extractedCode = extractCodeFromMarkdown(output)
    if (!extractedCode || extractedCode.trim() === "") {
      throw new Error("No code found in model output")
    } else {
      return { summary: "Code modifications applied", code: extractedCode }
    }
  }
  return { summary: report, code: codePart }
}

// Add retry configuration
const MAX_RETRIES = 5

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
      title: `Editing ${path.relative(Instance.worktree, filePath)}`,
      metadata: {
        status: "Reading target file",
        filePath: filePath,
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
      title: `Editing ${path.relative(Instance.worktree, filePath)}`,
      metadata: {
        status: "Resolving edit agents and models",
        filePath: filePath,
      },
    })

    // Resolve edit and apply agents and models
    const editAgent = await Agent.get("edit")
    // Silent fallback: if agent or model missing, just use default model
    const useModel = editAgent?.model
      ? await Provider.getModel(editAgent.model.providerID, editAgent.model.modelID)
      : await (async () => {
          const def = await Provider.defaultModel()
          return Provider.getModel(def.providerID, def.modelID)
        })()
    // Determine initial format preference
    const applyAgentForFormat = await Agent.get("apply")
    const hasApplyModelForFormat = !!applyAgentForFormat?.model
    let currentFormat = hasApplyModelForFormat ? Template.Format.Snippet : Template.Format.Diff

    // Build contextual messages (unchanged across retries)
    const fileMessages = [] as { role: "user"; content: string }[]
    fileMessages.push({
      role: "user",
      content: `// File: ${path.relative(Instance.directory, filePath)}\n${contentOld}`,
    })
    if (params.relevantFiles) {
      // Update status: building context
      ctx.metadata({
        title: `Editing ${path.relative(Instance.worktree, filePath)}`,
        metadata: {
          status: "Building contextual messages",
          filePath: filePath,
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
    let code = ""

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Update status: preparing prompt
      ctx.metadata({
        title: `Editing ${path.relative(Instance.worktree, filePath)}`,
        metadata: {
          status: `Preparing prompt (attempt ${attempt}/${MAX_RETRIES})`,
          filePath: filePath,
          attempt: attempt,
          maxRetries: MAX_RETRIES,
        },
      })

      // Build system messages for this format
      const example = currentFormat === Template.Format.Snippet ? SNIPPET_EXAMPLE : DIFF_EXAMPLE
      const substituted = await Template.substituteInputs(await Template.substitute(EDIT_TEMPLATE), {
        format: currentFormat,
        example,
      })
      const systemLines = substituted.split(/\n+/).filter((l) => l.trim().length > 0)
      const systemMsgs = systemLines.map((l) => ({ role: "system" as const, content: l }))

      // Assemble prompt, injecting prior error if retrying
      const messages = [...systemMsgs, ...fileMessages]
      if (attempt > 1 && lastError) {
        messages.push({ role: "user" as const, content: `Error:\n${lastError}` })
      }
      messages.push(finalUser)

      // Update status: calling model
      ctx.metadata({
        title: `Editing ${path.relative(Instance.worktree, filePath)}`,
        metadata: {
          status: `Calling AI model (attempt ${attempt}/${MAX_RETRIES})`,
          filePath: filePath,
          attempt: attempt,
          maxRetries: MAX_RETRIES,
        },
      })

      // Call LLM once per attempt. Fail fast if the model call itself fails.
      let editGen
      try {
        editGen = await generateText({
          model: useModel.language,
          temperature: 0,
          maxRetries: 0,
          messages,
        })
      } catch (err: any) {
        // Fail fast on model errors (do not retry)
        throw new Error(`Edit model call failed: ${err?.message || String(err)}`)
      }

      // Update status: parsing output
      ctx.metadata({
        title: `Editing ${path.relative(Instance.worktree, filePath)}`,
        metadata: {
          status: `Parsing model output (attempt ${attempt}/${MAX_RETRIES})`,
          filePath: filePath,
          attempt: attempt,
          maxRetries: MAX_RETRIES,
        },
      })

      const editOutput = editGen.text
      const parsed = parseEditOutput(editOutput)
      summary = parsed.summary
      code = parsed.code

      // Detect diff vs snippet for next iteration
      const looksLikeDiff = /^\s*(diff\s|@@)/m.test(code)
      if (attempt < MAX_RETRIES) {
        currentFormat = looksLikeDiff ? Template.Format.Diff : Template.Format.Snippet
      } else {
        currentFormat = Template.Format.Diff
      }

      const isEmptyCode = !code || code.trim() === ""
      const looksLikeNoChange = /^\s*(?:\[?no\s*changes?]?|n\/a|null|undefined|#|\/\/|<!--)/i.test((code || "").trim())

      if (isEmptyCode && summary && summary.trim() !== "") {
        throw new Error(summary || "Edit rejected by model")
      }

      const isReject = isEmptyCode || looksLikeNoChange
      if (isReject) {
        lastError = summary || "Edit rejected with missing explanation"
        continue
      }

      // Update status: applying edit
      ctx.metadata({
        title: `Editing ${path.relative(Instance.worktree, filePath)}`,
        metadata: {
          status: `Applying edit (attempt ${attempt}/${MAX_RETRIES})`,
          filePath: filePath,
          attempt: attempt,
          maxRetries: MAX_RETRIES,
        },
      })

      // Try to apply the edit and run diagnostics/write. If diagnostics indicate syntax errors,
      // allow another retry. Fail fast for other errors (including model failures inside apply).
      try {
        const applyAgent = await Agent.get("apply")
        const hasApplyModel = applyAgent?.model !== undefined

        const { contentNew, diff } = hasApplyModel
          ? await applyEditOutput(code, summary, ctx, filePath, contentOld)
          : await diffEditOutput(code, filePath, contentOld)

        if (contentNew === contentOld) {
          lastError = "Apply model failed to integrate the snippet"
          continue
        }

        // Update status: running diagnostics
        ctx.metadata({
          title: `Editing ${path.relative(Instance.worktree, filePath)}`,
          metadata: {
            status: "Running diagnostics and writing file",
            filePath: filePath,
          },
        })

        // This may throw a syntax-related exception; if so, retry.
        const { diagnostics } = await handleDiagnosticsAndFileWrite(filePath, contentNew, {
          ctx,
          diff,
          type: "edit",
        })

        return {
          metadata: {
            diagnostics,
            diff: diff,
          },
          title: `${path.relative(Instance.worktree, filePath)}`,
          output: summary || "Edit applied successfully",
        }
      } catch (err: any) {
        // Retry only for the SyntaxErrorAfterEdit thrown by handleDiagnosticsAndFileWrite
        if (err instanceof SyntaxErrorAfterEdit) {
          lastError = err.message
          // on last attempt we'll return the diagnostics captured from the exception
          continue
        }
        // For any other error (including model/apply failures), fail fast
        throw err
      }
    }

    throw new Error("Too many failed edit attempts: " + lastError)
  },
})
