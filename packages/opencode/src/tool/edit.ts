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
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Template } from "../util/template"
import { generateText } from "ai"
// Shared apply & utility functions
import { applyEditOutput, diffEditOutput, handleDiagnosticsAndFileWrite, trimDiff } from "../util/apply"
import { extractCodeFromMarkdown } from "../util/markdown"
import { Permission } from "../permission"
import { createTwoFilesPatch } from "diff"
// Re-export replace for existing tests that import from this module
export { replace } from "../util/apply"

// Bun runtime type declaration
declare const Bun: any

// Parse edit agent output to extract report and code
function parseEditOutput(output: string): { summary: string; code: string } {
  const lines = output.split("\n")
  let reportStart = -1
  let codeStart = -1

  // Find section markers (relaxed matching)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase()
    if (line.includes("report") && (line.startsWith("#") || line.includes(":"))) {
      reportStart = i + 1
    } else if (line.includes("code") && (line.startsWith("#") || line.includes(":"))) {
      codeStart = i + 1
      break
    }
  }

  // Extract report
  let summary = ""
  if (reportStart > -1 && codeStart > -1) {
    summary = lines
      .slice(reportStart, codeStart - 1)
      .filter((line) => !line.trim().startsWith("##"))
      .join("\n")
      .trim()
  }

  // Extract code
  let code = ""
  if (codeStart > -1) {
    code = lines.slice(codeStart).join("\n").trim()

    // Extract code from markdown if wrapped in code blocks
    code = extractCodeFromMarkdown(code)
  }

  // Fallback: if no structured format found, treat entire output as code
  if (!summary && !code) {
    const extractedCode = extractCodeFromMarkdown(output)
    return {
      summary: "Code modifications applied",
      code: extractedCode,
    }
  }

  return { summary, code }
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

    // Read the target file
    const file = Bun.file(filePath)
    const stats = await file.stat().catch(() => {})
    if (!stats) throw new Error(`File ${filePath} not found`)
    if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)
    await FileTime.assert(ctx.sessionID, filePath)
    const contentOld = await file.text()

    // Resolve edit and apply agents and models
    const editAgent = await Agent.get("edit")
    // Silent fallback: if agent or model missing, just use default model
    const useModel = editAgent?.model
      ? await Provider.getModel(editAgent.model.providerID, editAgent.model.modelID)
      : await (async () => {
          const def = await Provider.defaultModel()
          return Provider.getModel(def.providerID, def.modelID)
        })()
    const applyAgentForFormat = await Agent.get("apply")
    const hasApplyModelForFormat = !!applyAgentForFormat?.model
    const example = hasApplyModelForFormat ? SNIPPET_EXAMPLE : DIFF_EXAMPLE
    // Build system messages: keep any system lines from template after substitution
    const substitutedTemplate = await Template.substituteInputs(await Template.substitute(EDIT_TEMPLATE), {
      format: hasApplyModelForFormat ? Template.Format.Snippet : Template.Format.Diff,
      example,
    })
    const systemLines = substitutedTemplate.split(/\n+/).filter((l) => l.trim().length > 0)
    const systemMsgs = systemLines.map((l) => ({ role: "system" as const, content: l }))
    // Build contextual messages for target + relevant files
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
    // Final user message includes instructions last
    const finalUser = { role: "user" as const, content: `## Instructions\n${params.instructions}` }
    const editGen = await generateText({
      model: useModel.language,
      temperature: 0,
      maxRetries: 5,
      messages: [...systemMsgs, ...fileMessages, finalUser],
    })
    const editOutput = editGen.text

    // Parse the edit output to extract summary and code
    const { summary, code } = parseEditOutput(editOutput)

    // Detect rejection: empty or semantically empty code block
    const isReject =
      !code || code.trim() === "" || /^\s*(?:\[?no\s*changes?]?|n\/a|null|undefined|#|\/\/|<!--).*$/i.test(code.trim())
    if (isReject) {
      return {
        metadata: { diagnostics: {}, diff: "" },
        title: `${path.relative(Instance.worktree, filePath)}`,
        output: summary || "Edit rejected by model",
      }
    }

    // Check if we have an apply agent configured with a model
    const applyAgent = await Agent.get("apply")
    const hasApplyModel = applyAgent?.model !== undefined

    // Apply the edit using the appropriate method
    const result = hasApplyModel
      ? await applyEditOutput(code, summary, ctx, filePath, contentOld)
      : await diffEditOutput(code, ctx, filePath, contentOld)

    const contentNew = result.contentNew ?? contentOld

    // Build diff (applyEditOutput/diffEditOutput already returns diff, but ensure trimmed) and ask permission if required
    const diff = trimDiff(
      result.diff || createTwoFilesPatch(filePath, filePath, contentOld, contentNew),
    )
    const agent = await Agent.get(ctx.agent)
    if (agent?.permission.edit === "ask") {
      await Permission.ask({
        type: "edit",
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        title: "Edit this file: " + filePath,
        metadata: { filePath, diff },
      })
    }

    const { diagnostics } = await handleDiagnosticsAndFileWrite(filePath, contentNew, ctx)

    return {
      metadata: {
        diagnostics,
  diff: diff,
      },
      title: `${path.relative(Instance.worktree, filePath)}`,
      output: summary || "Edit applied successfully",
    }
  },
})
