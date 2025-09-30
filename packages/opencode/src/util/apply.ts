import { replace } from "./replace"
import { LSP } from "../lsp"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { Agent } from "../agent/agent"
import { generateText } from "ai"
import * as path from "path"
import { Instance } from "../project/instance"
import { createTwoFilesPatch } from "diff"
import { Permission } from "../permission"
import { extractCodeFromMarkdown } from "./extract"
import { readFile } from "fs/promises"
import { buildSupportModelParams } from "../session/support-model-params"
import type { LSPClient } from "../lsp/client"
import type { Tool } from "../tool/tool"

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

  ctx.metadata({
    metadata: {
      status: "Running diagnostics",
    },
  })

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

  // Only block write if there are diagnostics for the target file
  if (diagnostics[absolutePath] && diagnostics[absolutePath].length > 0) {
    try {
      await LSP.revertVirtualContent(absolutePath)
    } catch {}
    ctx.metadata({
      metadata: {
        diagnostics: diagnostics,
        status: "Encountered diagnostic errors",
        error: "Diagnostic errors detected",
      },
    })
    return { diagnostics, absolutePath, diff: diffOpt }
  }

  ctx.metadata({
    metadata: {
      diagnostics: diagnostics,
      status: "No diagnostic errors detected",
      error: "", // Clear any previous error
    },
  })

  let diff: string
  if (diffOpt) {
    // Use provided diff directly
    diff = trimDiff(diffOpt)
  } else {
    // Compute diff when not provided
    let contentOld: string
    try {
      contentOld = await readFile(absolutePath, "utf-8")
    } catch (err: any) {
      // If file doesn't exist, use empty string as old content
      if (err?.code === "ENOENT") {
        contentOld = ""
      } else {
        // For other errors, try to revert virtual content and re-throw
        try {
          await LSP.revertVirtualContent(absolutePath)
        } catch {}
        throw err
      }
    }
    const rawDiff = createTwoFilesPatch(filePath, filePath, contentOld, contentNew)
    diff = trimDiff(rawDiff)
  }

  ctx.metadata({
    metadata: {
      status: "Waiting for permission to write file",
    },
  })

  const permissionType: "edit" | "write" = type
  // Check if LSP was unavailable (empty diagnostics object means no LSP clients)
  const lspUnavailable = Object.keys(diagnostics).length === 0

  // Prompt for permission after diagnostics pass, unless skipped
  if (!skipPermission) {
    const agent = await Agent.get(ctx.agent)
    // Determine permission based on edit permission for both edit and write
    // When LSP is unavailable, use strict mode to require approval even in build mode
    if (agent.permission.edit === "ask" || lspUnavailable) {
      await Permission.ask({
        type: permissionType,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        title:
          title ??
          `${permissionType === "edit" ? "Edit" : "Write"} this file: ${absolutePath}${lspUnavailable ? " (LSP unavailable)" : ""}`,
        metadata: { filePath: absolutePath, diff, lspUnavailable },
        ...(lspUnavailable && { strict: true }),
      })
    }
  }

  ctx.metadata({
    metadata: {
      status: "Writing file to storage",
    },
  })

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

  return { diagnostics, absolutePath, diff }
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
  // Get model and options using 4-tier fallback (with glob matching) via helper
  const { params: supportParams, modelInfo: modelInfo, prompt } = await buildSupportModelParams(
    "apply",
    ctx.agent,
    ctx.sessionID,
    filePath,
  )

  let contentNew: string | undefined

  // Path 1: Morph/Relace models (OpenAI API with special XML format)
  if (modelInfo.modelID.includes("morph") || modelInfo.modelID.includes("relace")) {
    const applyMsg = `<instruction>${summary || "Apply edit"}</instruction>\n<code>${contentOld}</code>\n<update>${editOutput}</update>`
    const gen = await generateText({
      ...supportParams,
      maxRetries: 5,
      messages: [{ role: "user", content: applyMsg }],
    })
    contentNew = extractCodeFromMarkdown(gen.text)
  } else {
    // Path 2: Generic fallback (all other models)
    const promptText = prompt ? prompt.trim() : ""
    const instruction = promptText ? promptText + "\n\n" : ""
    const userContent = `${instruction}File: ${path.relative(Instance.directory, filePath)}\n\n--- ORIGINAL START ---\n${contentOld}\n--- ORIGINAL END ---\n\n--- CHANGES START ---\n${editOutput}\n--- CHANGES END ---`
    const gen = await generateText({
      ...supportParams,
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
