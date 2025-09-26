import { replace } from "./replace"
import { LSP } from "../lsp"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Template } from "./template"
import { generateText } from "ai"
import * as path from "path"
import { Instance } from "../project/instance"
import { createTwoFilesPatch } from "diff"
import { Permission } from "../permission"
import { extractCodeFromMarkdown } from "./extract"
import { readFile } from "fs/promises"
import type { LSPClient } from "../lsp/client"
import type { Tool } from "../tool/tool"

// Specific error thrown when diagnostics report syntax/type errors after applying an edit
export class SyntaxErrorAfterEdit extends Error {
  public fileErrors: LSPClient.Diagnostic[]
  constructor(message: string, fileErrors: LSPClient.Diagnostic[]) {
    super(message)
    this.name = "SyntaxErrorAfterEdit"
    this.fileErrors = fileErrors
  }
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

// Shared function to handle LSP diagnostics, permission and file writing
export async function handleDiagnosticsAndFileWrite(
  filePath: string,
  contentNew: string,
  options: {
    ctx: any
    diff?: string
    type?: "edit" | "write"
    title?: string
    skipPermission?: boolean
  },
) {
  const { ctx, diff: diffOpt, type = "edit", title, skipPermission } = options
  const absolutePath = path.resolve(filePath)

  // Push virtual content and capture diagnostics map
  let diagnostics: Record<string, LSPClient.Diagnostic[]>
  try {
    diagnostics = await LSP.pushVirtualContent(absolutePath, contentNew)
  } catch (err) {
    try {
      await LSP.revertVirtualContent(absolutePath)
    } catch {}
    throw err
  }

  // Filter for severity-1 errors
  const fileDiagnostics = diagnostics[absolutePath]?.filter((diag: LSPClient.Diagnostic) => diag.severity === 1) || []
  if (fileDiagnostics.length > 0) {
    try {
      await LSP.revertVirtualContent(absolutePath)
    } catch {}
    const errorMessage = `File has errors after edit:\n${fileDiagnostics.map(LSP.Diagnostic.pretty).join("\n")}`
    throw new SyntaxErrorAfterEdit(errorMessage, fileDiagnostics)
  }

  let diff: string
  if (diffOpt) {
    // Use provided diff directly
    diff = trimDiff(diffOpt)
  } else {
    // Compute diff when not provided
    let contentOld: string
    try {
      contentOld = await readFile(absolutePath, "utf-8")
    } catch (err) {
      try {
        await LSP.revertVirtualContent(absolutePath)
      } catch {}
      throw err
    }
    const rawDiff = createTwoFilesPatch(filePath, filePath, contentOld, contentNew)
    diff = trimDiff(rawDiff)
  }

  const permissionType: "edit" | "write" = type
  // Prompt for permission after diagnostics pass, unless skipped
  if (!skipPermission) {
    const agent = await Agent.get(ctx.agent)
    // Determine permission based on edit permission for both edit and write
    if (agent.permission.edit === "ask") {
      await Permission.ask({
        type: permissionType,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        title: title ?? `${permissionType === "edit" ? "Edit" : "Write"} this file: ${absolutePath}`,
        metadata: { filePath: absolutePath, diff },
      })
    }
  }

  // Write file to disk
  try {
    await Bun.write(absolutePath, contentNew)
  } catch (err) {
    try {
      await LSP.revertVirtualContent(absolutePath)
    } catch {}
    throw err
  }

  // Restore virtual document, then publish edit and update timestamps
  try {
    await LSP.revertVirtualContent(absolutePath)
  } catch {}
  await Bus.publish(File.Event.Edited, { file: absolutePath })
  FileTime.read(ctx.sessionID, absolutePath)
  await LSP.touchFile(absolutePath)

  return { diagnostics, diff }
}

export { replace }

// Apply edit output using apply agent
export async function applyEditOutput(
  editOutput: string,
  summary: string,
  ctx: Tool.Context<any>,
  filePath: string,
  contentOld: string,
) {
  const agent = await Agent.get(ctx.agent)
  const applyAgent = await Agent.get("apply")
  // Silent fallback if no apply agent or model
  const modelInfo = applyAgent?.model
    ? await Provider.getModel(applyAgent.model.providerID, applyAgent.model.modelID)
    : agent.model
      ? await Provider.getModel(agent.model?.providerID, agent.model.modelID)
      : await (async () => {
          const def = await Provider.defaultModel()
          return Provider.getModel(def.providerID, def.modelID)
        })()

  let contentNew: string | undefined
  // Provider/model specific application
  if (modelInfo.modelID.includes("morph")) {
    // Morph expects single user message with instruction/code/update tags
    const applyMsg = `<instruction>${summary || "Apply edit"}</instruction>\n<code>${contentOld}</code>\n<update>${editOutput}</update>`
    const gen = await generateText({
      model: modelInfo.language,
      temperature: 0,
      maxRetries: 5,
      messages: [{ role: "user", content: applyMsg }],
    })
    contentNew = extractCodeFromMarkdown(gen.text)
  } else if (modelInfo.providerID === "relace" && modelInfo.modelID === "apply") {
    // Relace apply endpoint (no chat prompt semantics)
    try {
      const endpoint = (modelInfo.info.options && (modelInfo.info.options as any)["endpoint"]) || "/v1/code/apply"
      const providerApi = (modelInfo.info as any).provider && (modelInfo.info as any).provider.api
      const base = providerApi || (modelInfo.info.options && (modelInfo.info.options as any)["baseURL"]) || ""
      const url = base.endsWith("/") ? base.slice(0, -1) + endpoint : base + endpoint
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: process.env["RELACE_API_KEY"] ? `Bearer ${process.env["RELACE_API_KEY"]}` : "",
        },
        body: JSON.stringify({ initialCode: contentOld, editSnippet: editOutput }),
      })
      if (resp.ok) {
        const json: any = await resp.json().catch(() => ({}))
        contentNew = json.mergedCode || json.code || json.result || contentOld
      }
    } catch {
      // swallow; relace failure does NOT fall back to generic path per spec request
    }
  } else {
    // Generic fallback ONLY when neither morph nor relace
    const promptText = applyAgent?.prompt ? (await Template.substitute(applyAgent.prompt)).trim() : ""
    const instruction = promptText ? promptText + "\n\n" : ""
    const userContent = `${instruction}File: ${path.relative(Instance.directory, filePath)}\n\n--- ORIGINAL START ---\n${contentOld}\n--- ORIGINAL END ---\n\n--- CHANGES START ---\n${editOutput}\n--- CHANGES END ---`
    const gen = await generateText({
      model: modelInfo.language,
      temperature: 0,
      maxRetries: 5,
      messages: [{ role: "user", content: userContent }],
    })
    contentNew = extractCodeFromMarkdown(gen.text)
  }

  // Ensure we have a concrete new content (fallback to old if all strategies failed)
  if (contentNew === undefined || contentNew === "") {
    contentNew = contentOld
  }
  // Create diff for permission check
  const diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))

  return { contentNew, diff }
}

// Parse fuzzy diff output to extract oldString and newString
export function parseFuzzyDiff(output: string): { oldString: string; newString: string } {
  // First extract code from markdown if present
  const extractedOutput = extractCodeFromMarkdown(output)
  const lines = extractedOutput.split("\n")
  let oldString = ""
  let newString = ""

  // Try multiple patterns to extract old and new code sections

  // Pattern 1: Look for unified diff format
  if (extractedOutput.includes("@@") && (extractedOutput.includes("-") || extractedOutput.includes("+"))) {
    for (const line of lines) {
      if (line.startsWith("-") && !line.startsWith("---")) {
        oldString += line.substring(1) + "\n"
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        newString += line.substring(1) + "\n"
      }
    }
  }

  // Pattern 2: Look for explicit old/new sections
  if (!oldString || !newString) {
    let inOld = false
    let inNew = false

    for (const line of lines) {
      const trimmed = line.trim().toLowerCase()

      if (
        trimmed.includes("old:") ||
        trimmed.includes("replace:") ||
        trimmed.includes("before:") ||
        trimmed.includes("from:")
      ) {
        inOld = true
        inNew = false
        continue
      }
      if (
        trimmed.includes("new:") ||
        trimmed.includes("with:") ||
        trimmed.includes("after:") ||
        trimmed.includes("to:")
      ) {
        inOld = false
        inNew = true
        continue
      }

      if (inOld && !trimmed.startsWith("##") && !trimmed.includes(":")) {
        oldString += line + "\n"
      } else if (inNew && !trimmed.startsWith("##") && !trimmed.includes(":")) {
        newString += line + "\n"
      }
    }
  }

  // Pattern 3: Look for code blocks with context
  if (!oldString || !newString) {
    const codeBlocks = []
    let inCodeBlock = false
    let currentBlock = ""

    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        if (inCodeBlock) {
          codeBlocks.push(currentBlock.trim())
          currentBlock = ""
          inCodeBlock = false
        } else {
          inCodeBlock = true
        }
        continue
      }

      if (inCodeBlock) {
        currentBlock += line + "\n"
      }
    }

    // If we have exactly 2 code blocks, assume first is old, second is new
    if (codeBlocks.length === 2) {
      oldString = codeBlocks[0]
      newString = codeBlocks[1]
    }
  }

  return {
    oldString: oldString.trim(),
    newString: newString.trim(),
  }
}

// Apply a diff to content to get the modified content
export function applyDiffToContent(originalContent: string, diff: string): string {
  const lines = originalContent.split("\n")
  const diffLines = diff.split("\n")

  // Simple diff application - handles basic unified diff format
  let result = [...lines]
  let lineOffset = 0

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i]

    if (line.startsWith("@@")) {
      // Parse hunk header to get line numbers
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/)
      if (match) {
        lineOffset = parseInt(match[1]) - 1 // Convert to 0-based index
      }
      continue
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      // Remove line
      const lineContent = line.substring(1)
      const index = result.findIndex((l, idx) => idx >= lineOffset && l === lineContent)
      if (index !== -1) {
        result.splice(index, 1)
        lineOffset = index
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      // Add line
      const lineContent = line.substring(1)
      result.splice(lineOffset, 0, lineContent)
      lineOffset++
    } else if (line.startsWith(" ")) {
      // Context line - advance offset
      lineOffset++
    }
  }

  return result.join("\n")
}

// Use traditional diff method - edit output should be a proper diff
export async function diffEditOutput(editOutput: string, filePath: string, contentOld: string) {
  // Extract code from markdown code blocks if present
  const extractedCode = extractCodeFromMarkdown(editOutput)
  let diff = extractedCode.trim()

  // If the diff doesn't look like a proper diff, try to parse it as fuzzy diff
  if (!diff.includes("@@") && !(diff.includes("-") && diff.includes("+"))) {
    // Fallback to fuzzy parsing if the edit agent didn't output proper diff format
    const { oldString, newString } = parseFuzzyDiff(extractedCode)

    if (!oldString || !newString) {
      throw new Error(
        "Edit agent output must be a proper diff format or contain identifiable old and new code sections",
      )
    }

    // Use the sophisticated replace function with fuzzy matching
    const contentNew = replace(contentOld, oldString, newString, false)
    diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
  }

  const contentNew = applyDiffToContent(contentOld, diff)

  return { contentNew, diff }
}
