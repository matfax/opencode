import z from "zod/v4"
import { Tool } from "./tool"
import DESCRIPTION from "./multiedit.txt"
import path from "path"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { generateText } from "ai"
import { Agent } from "../agent/agent"
import { Template } from "../util/template"
import { handleDiagnosticsAndFileWrite, trimDiff, diffEditOutput, applyEditOutput } from "../util/apply"
import { RemoveTool } from "./remove"
import { createTwoFilesPatch } from "diff"
import { File } from "../file"
import { Bus } from "../bus"
import { FileTime } from "../file/time"
import { Permission } from "../permission"
import fs from "fs/promises"
import { parseReportAndCodeSections } from "../util/extract"
import { buildSupportModelParams } from "../session/support-model-params"
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
    instructions: z.string().optional().describe("Natural language multi-file instructions"),
    relevantFiles: z.array(z.string()).optional().describe("Optional list of context files"),
  }),
  async execute(params, ctx) {
    if (!params.instructions || params.instructions.trim() === "") throw new Error("instructions required")

    // Determine format (snippet or diff) based on apply model presence
    const applyAgentForFormat = await Agent.get("apply")
    const hasApplyModelForFormat = !!applyAgentForFormat?.model
    const format = hasApplyModelForFormat ? Template.Format.Snippet : Template.Format.Diff

    // Use first relevant file as representative for model selection (if available)
    const representativeFile = params.relevantFiles?.[0]
      ? path.isAbsolute(params.relevantFiles[0])
        ? params.relevantFiles[0]
        : path.join(Instance.directory, params.relevantFiles[0])
      : undefined

    // System template reuse from single edit tool support examples
    // We keep it simple: instruct model to output angle sentinel sections
    const example = format === Template.Format.Snippet ? MULTISNIPPET_EXAMPLE : MULTIDIFF_EXAMPLE
    const { params: supportParams, prompt } = await buildSupportModelParams(
      "edit",
      ctx.agent,
      ctx.sessionID,
      representativeFile,
    )
    const baseTemplate = prompt ?? MULTIEDIT_TEMPLATE
    const substituted = await Template.substituteInputs(await Template.substitute(baseTemplate), {
      format: format,
      example,
    })
    const systemLines = substituted
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const systemMsgs = systemLines.map((l) => ({ role: "system" as const, content: l }))

    const MAX_EXPANSION_ATTEMPTS = 3
    const MAX_CONTEXT_FILES = 30
    const baseRelevant = new Set<string>(params.relevantFiles || [])
    const attemptedFiles = new Set<string>([...baseRelevant])

    let sections: Section[] = []
    let attempt = 0
    let raw = ""
    let expanded = false
    let lastReport = ""
    const expansionLog: { attempt: number; added: string[] }[] = []
    while (attempt < MAX_EXPANSION_ATTEMPTS) {
      // Build context messages for this attempt
      const fileMessages: { role: "user"; content: string }[] = []
      for (const rel of baseRelevant) {
        try {
          const abs = validatePath(rel)
          const content = await readFileIfExists(abs)
          if (content != null)
            fileMessages.push({
              role: "user",
              content: `// File: ${path.relative(Instance.directory, abs)}\n${content}`,
            })
        } catch {}
      }
      const finalUser = { role: "user" as const, content: `## Instructions\n${params.instructions}` }

      const gen = await generateText({
        ...supportParams,
        maxRetries: 5,
        messages: [...systemMsgs, ...fileMessages, finalUser],
      })
      raw = gen.text

      const { report, codePart } = parseReportAndCodeSections(raw)
      if (report) lastReport = report
      sections = parseMultiFileOutput(codePart)
      if (sections.length === 0) {
        if (attempt === 0)
          return {
            title: "multiedit",
            metadata: { results: [] as any[], expanded: false, expansionLog: [], summary: lastReport },
            output: lastReport || "No changes",
          }
        break
      }

      // Detect off-context files
      const offContext = new Set<string>()
      for (const s of sections) {
        if (["modify", "rename", "delete"].includes(s.action)) {
          if (!baseRelevant.has(s.file)) offContext.add(s.file)
          if (s.action === "rename" && s.to && !baseRelevant.has(s.file)) offContext.add(s.file) // source file must be known
        }
      }
      if (offContext.size === 0) break
      // Add them if under limits
      const newlyAdded: string[] = []
      for (const f of offContext) {
        if (baseRelevant.size >= MAX_CONTEXT_FILES) break
        if (!attemptedFiles.has(f)) {
          baseRelevant.add(f)
          attemptedFiles.add(f)
          newlyAdded.push(f)
        }
      }
      if (newlyAdded.length === 0) break
      expanded = true
      expansionLog.push({ attempt: attempt + 1, added: newlyAdded })
      attempt++
      continue
    }
    if (
      attempt >= MAX_EXPANSION_ATTEMPTS &&
      sections.some((s) => ["modify", "rename", "delete"].includes(s.action) && !baseRelevant.has(s.file))
    ) {
      throw new Error("Exceeded max multiedit expansion attempts while resolving off-context files")
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
      // Safety check still: ensure after expansion the file is in context for destructive ops
      if (
        ["modify", "rename", "delete"].includes(action) &&
        ![...baseRelevant].some((r) => path.normalize(r) === path.normalize(relPath))
      ) {
        throw new Error(`Internal: file ${relPath} missing from expanded context set`)
      }

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
        // Delegate permission and diagnostics to helper
        const { diagnostics } = await handleDiagnosticsAndFileWrite(absPath, newContent, { ctx, diff, type: "write" })
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
      if (action === "rename") {
        if (existingContent == null) throw new Error(`File not found: ${relPath}`)
        if (!targetAbs) throw new Error("Missing target for rename")
        if (await readFileIfExists(targetAbs)) throw new Error(`Target exists: ${section.to}`)
        const diff = trimDiff(createTwoFilesPatch(absPath, absPath, existingContent, existingContent))
        if (agent?.permission.edit === "ask") {
          await Permission.ask({
            type: "edit",
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            title: `Rename file: ${absPath} -> ${targetAbs}`,
            metadata: { filePath: absPath, to: targetAbs, action },
          })
        }
        await fs.mkdir(path.dirname(targetAbs), { recursive: true }).catch(() => {})
        await fs.rename(absPath, targetAbs)
        await Bus.publish(File.Event.Edited, { file: targetAbs })
        FileTime.read(ctx.sessionID, targetAbs)
        results.push({ file: relPath, action, to: section.to, diff, diagnostics: {} })
        continue
      }
      if (action === "modify") {
        if (existingContent == null) throw new Error(`File not found: ${relPath}`)
        let contentNew: string = existingContent
        let diff: string = ""
        if (format === Template.Format.Snippet) {
          const snippet = section.body.join("\n").trimEnd()
          const result = await applyEditOutput(snippet, `Multi edit modify ${absPath}`, ctx, absPath, existingContent)
          contentNew = result.contentNew ?? existingContent
          diff = result.diff
        } else {
          const diffText = section.body.join("\n")
          const result = await diffEditOutput(diffText, absPath, existingContent)
          contentNew = result.contentNew ?? existingContent
          diff = result.diff
        }
        // Delegate permission and diagnostics to helper
        const { diagnostics } = await handleDiagnosticsAndFileWrite(absPath, contentNew, { ctx, diff, type: "edit" })
        results.push({ file: relPath, action, diff, diagnostics })
        continue
      }
    }

    const summary =
      lastReport || (expanded ? "Multi-file edits applied (context expanded)" : "Multi-file edits applied")
    return { title: "multiedit", metadata: { results, expanded: !!expanded, expansionLog, summary }, output: summary }
  },
})
