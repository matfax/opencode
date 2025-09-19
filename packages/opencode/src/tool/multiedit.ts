import z from "zod/v4"
import { Tool } from "./tool"
import DESCRIPTION from "./multiedit.txt"
import path from "path"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { generateText } from "ai"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Template } from "../util/template"
import { handleDiagnosticsAndFileWrite, trimDiff, applyDiffToContent } from "../util/apply"
import { RemoveTool } from "./remove"
import { createTwoFilesPatch } from "diff"
import { File } from "../file"
import { Bus } from "../bus"
import { FileTime } from "../file/time"
import { Permission } from "../permission"
import fs from "fs/promises"
import { extractCodeFromMarkdown } from "../util/markdown"
// @ts-ignore
import MULTIEDIT_TEMPLATE from "./support/multiedit.txt"
// @ts-ignore
import MULTIDIFF_EXAMPLE from "./support/multidiff.txt"
// @ts-ignore
import MULTISNIPPET_EXAMPLE from "./support/multisnippet.txt"

// Angle sentinel header regex
const SECTION_RE = /^<<<file:(\S+) action:(create|modify|delete|rename)(?: to:(\S+))?>>>$/

type Section = {
  file: string
  action: "create" | "modify" | "delete" | "rename"
  to?: string
  body: string[]
}

function parseMultiFileOutput(text: string): Section[] {
  const sections: Section[] = []
  let current: Section | null = null
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\r$/, "")
    const m = line.match(SECTION_RE)
    if (m) {
      if (current) sections.push(current)
      current = { file: m[1], action: m[2] as Section["action"], to: m[3], body: [] }
      continue
    }
    if (!current) continue
    current.body.push(line)
  }
  if (current) sections.push(current)
  return sections
}

async function readFileIfExists(abs: string): Promise<string | null> {
  try {
    const f = Bun.file(abs)
    const st = await f.stat()
    if (!st || st.isDirectory()) return null
    return await f.text()
  } catch {
    return null
  }
}

function validatePath(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(Instance.directory, p)
  if (!Filesystem.contains(Instance.directory, abs)) throw new Error(`Path escapes project: ${p}`)
  return abs
}

export const MultiEditTool = Tool.define("multiedit", {
  description: DESCRIPTION,
  parameters: z.object({
    // Legacy mode
    filePath: z.string().optional().describe("Legacy: base file path for sequential edits"),
    edits: z
      .array(
        z.object({
          filePath: z.string().optional(),
          instructions: z.string(),
        }),
      )
      .optional(),
    // New generation mode
    instructions: z.string().optional().describe("Natural language multi-file instructions"),
    relevantFiles: z.array(z.string()).optional().describe("Optional list of context files"),
  }),
  async execute(params, ctx) {
    // Legacy fallback: sequential single-file edits forwarded to edit tool
    if (params.filePath && params.edits && params.edits.length) {
      const editTool = await (await import("./edit")).EditTool.init()
      const results = []
      for (const e of params.edits) {
        const r = await editTool.execute({ filePath: e.filePath ?? params.filePath, instructions: e.instructions }, ctx)
        results.push(r)
      }
      return {
        title: path.relative(Instance.worktree, params.filePath),
        metadata: { results: results.map((r) => r.metadata) },
        output: results.at(-1)?.output || "",
      }
    }

    if (!params.instructions || params.instructions.trim() === "") throw new Error("instructions required")

    // Determine format (snippet or diff) based on apply model presence
    const applyAgentForFormat = await Agent.get("apply")
    const hasApplyModelForFormat = !!applyAgentForFormat?.model
    const format = hasApplyModelForFormat ? Template.Format.Snippet : Template.Format.Diff

    // System template reuse from single edit tool support examples
    // We keep it simple: instruct model to output angle sentinel sections
    const example = format === Template.Format.Snippet ? MULTISNIPPET_EXAMPLE : MULTIDIFF_EXAMPLE
    const substituted = await Template.substituteInputs(await Template.substitute(MULTIEDIT_TEMPLATE), {
      format: format,
      example,
    })
    const systemLines = substituted
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const systemMsgs = systemLines.map((l) => ({ role: "system" as const, content: l }))

    // Gather context files
    const ctxFiles: string[] = []
    if (params.relevantFiles) ctxFiles.push(...params.relevantFiles)
    const fileMessages = [] as { role: "user"; content: string }[]
    for (const rel of ctxFiles) {
      try {
        const abs = validatePath(rel)
        const content = await readFileIfExists(abs)
        if (content != null)
          fileMessages.push({ role: "user", content: `// File: ${path.relative(Instance.directory, abs)}\n${content}` })
      } catch {}
    }
    const finalUser = { role: "user" as const, content: `## Instructions\n${params.instructions}` }

    const editAgent = await Agent.get("multiedit")
    const useModel = editAgent?.model
      ? await Provider.getModel(editAgent.model.providerID, editAgent.model.modelID)
      : await (async () => {
          const def = await Provider.defaultModel()
          return Provider.getModel(def.providerID, def.modelID)
        })()

    const gen = await generateText({
      model: useModel.language,
      temperature: 0,
      maxRetries: 5,
      messages: [...systemMsgs, ...fileMessages, finalUser],
    })
    const raw = gen.text

    // Split report and code (reuse simple heuristic)
    const lower = raw.toLowerCase()
    let codePart = raw
    if (lower.includes("## code")) {
      const idx = lower.indexOf("## code")
      codePart = raw.slice(idx)
    }
    codePart = extractCodeFromMarkdown(codePart)

    // Parse sections
    const sections = parseMultiFileOutput(codePart)
    if (sections.length === 0) {
      return { title: "multiedit", metadata: { results: [] }, output: "No changes" }
    }

    const results: any[] = []
    const agent = await Agent.get(ctx.agent)
    for (const section of sections) {
      const relPath = section.file
      const absPath = validatePath(relPath)
      const existingContent = await readFileIfExists(absPath)
      let action = section.action
      if (action === "rename" && !section.to) throw new Error(`Rename missing to: path for ${relPath}`)
      const targetAbs = section.to ? validatePath(section.to) : undefined

      if (action === "create") {
        if (existingContent != null) throw new Error(`File already exists: ${relPath}`)
        const newContent =
          format === Template.Format.Snippet
            ? section.body.join("\n").trimEnd()
            : section.body
                .filter((l) => l.startsWith("+"))
                .map((l) => l.slice(1))
                .join("\n")
        const diff = trimDiff(createTwoFilesPatch(absPath, absPath, "", newContent))
        if (agent?.permission.edit === "ask") {
          await Permission.ask({
            type: "edit",
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            title: "Create file: " + absPath,
            metadata: { filePath: absPath, diff },
          })
        }
        const { diagnostics } = await handleDiagnosticsAndFileWrite(absPath, newContent, ctx)
        results.push({ file: relPath, action, diff, diagnostics })
        continue
      }
      if (action === "delete") {
        if (existingContent == null) throw new Error(`File not found for delete: ${relPath}`)
        const removeTool = await RemoveTool.init()
        const diff = trimDiff(createTwoFilesPatch(absPath, absPath, existingContent, ""))
        await removeTool.execute({ filePath: absPath }, ctx)
        results.push({ file: relPath, action, diff, diagnostics: {} })
        continue
      }
      if (action === "modify" || action === "rename") {
        if (existingContent == null) throw new Error(`File not found: ${relPath}`)
        let appliedContent = existingContent
        if (format === Template.Format.Snippet) {
          appliedContent = section.body.join("\n").trimEnd()
        } else {
          // Diff mode: assemble patch body and apply
          const diffBody = section.body.join("\n")
          let diffText = diffBody
          if (!(diffText.includes("@@") || diffText.includes("+") || diffText.includes("-"))) {
            diffText = diffBody
          }
          appliedContent = applyDiffToContent(existingContent, diffText)
        }
        let finalAbs = absPath
        if (action === "rename") {
          if (!targetAbs) throw new Error("Missing target for rename")
          if (await readFileIfExists(targetAbs)) throw new Error(`Target exists: ${section.to}`)
          finalAbs = targetAbs
        }
        const diff = trimDiff(createTwoFilesPatch(absPath, absPath, existingContent, appliedContent))
        if (agent?.permission.edit === "ask") {
          await Permission.ask({
            type: "edit",
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            title: action === "rename" ? `Modify & rename file: ${absPath} -> ${finalAbs}` : `Modify file: ${absPath}`,
            metadata: { filePath: absPath, to: finalAbs, diff, action },
          })
        }
        // Write changes (on original path first for stable diff reference)
        const { diagnostics } = await handleDiagnosticsAndFileWrite(absPath, appliedContent, ctx)
        if (action === "rename" && finalAbs !== absPath) {
          // Ensure target directory exists
          await fs.mkdir(path.dirname(finalAbs), { recursive: true }).catch(() => {})
          await fs.rename(absPath, finalAbs)
          await Bus.publish(File.Event.Edited, { file: finalAbs })
          FileTime.read(ctx.sessionID, finalAbs)
        }
        results.push({ file: relPath, action, to: section.to, diff, diagnostics })
        continue
      }
    }

    return { title: "multiedit", metadata: { results }, output: "Multi-file edits applied" }
  },
})
