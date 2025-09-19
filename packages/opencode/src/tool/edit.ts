// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import z from "zod/v4"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import { Permission } from "../permission"
import * as DESCRIPTION from "./edit.txt"
// Statically import template + examples
// @ts-ignore
import EDIT_TEMPLATE from "./support/edit.txt"
// @ts-ignore
import SNIPPET_EXAMPLE from "./support/snippet.txt"
// @ts-ignore
import DIFF_EXAMPLE from "./support/diff.txt"
import { File } from "../file"
import { Bus } from "../bus"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Template } from "../util/template"
import { generateText } from "ai"

// Bun runtime type declaration
declare const Bun: any

// Extract code from markdown code blocks gracefully
function extractCodeFromMarkdown(text: string): string {
  const trimmed = text.trim()
  
  // Check for code blocks with language specifier
  const codeBlockMatch = trimmed.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```$/m)
  if (codeBlockMatch) {
    return codeBlockMatch[1]
  }
  
  // Check for code blocks without language specifier
  const simpleCodeBlockMatch = trimmed.match(/^```\s*\n([\s\S]*?)\n```$/m)
  if (simpleCodeBlockMatch) {
    return simpleCodeBlockMatch[1]
  }
  
  // Check for inline code blocks spanning the entire text
  if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
    const lines = trimmed.split('\n')
    // Remove first line (opening ```) and last line (closing ```)
    if (lines.length >= 2) {
      lines.shift()
      lines.pop()
      return lines.join('\n')
    }
  }
  
  // Check for multiple code blocks and extract the largest one
  const allCodeBlocks = trimmed.match(/```(?:\w+)?\s*\n([\s\S]*?)\n```/g)
  if (allCodeBlocks && allCodeBlocks.length > 0) {
    // Extract content from each block and return the longest one
    let longestBlock = ""
    for (const block of allCodeBlocks) {
      const content = block.replace(/^```(?:\w+)?\s*\n/, '').replace(/\n```$/, '')
      if (content.length > longestBlock.length) {
        longestBlock = content
      }
    }
    if (longestBlock) {
      return longestBlock
    }
  }
  
  // If no code blocks found, return the original text
  return trimmed
}

// Parse edit agent output to extract report and code
function parseEditOutput(output: string): { summary: string; code: string } {
  const lines = output.split('\n')
  let reportStart = -1
  let codeStart = -1
  
  // Find section markers (relaxed matching)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase()
    if (line.includes('report') && (line.startsWith('#') || line.includes(':'))) {
      reportStart = i + 1
    } else if (line.includes('code') && (line.startsWith('#') || line.includes(':'))) {
      codeStart = i + 1
      break
    }
  }
  
  // Extract report
  let summary = ""
  if (reportStart > -1 && codeStart > -1) {
    summary = lines.slice(reportStart, codeStart - 1)
      .filter(line => !line.trim().startsWith('##'))
      .join('\n')
      .trim()
  }
  
  // Extract code
  let code = ""
  if (codeStart > -1) {
    code = lines.slice(codeStart)
      .join('\n')
      .trim()
    
    // Extract code from markdown if wrapped in code blocks
    code = extractCodeFromMarkdown(code)
  }
  
  // Fallback: if no structured format found, treat entire output as code
  if (!summary && !code) {
    const extractedCode = extractCodeFromMarkdown(output)
    return {
      summary: "Code modifications applied",
      code: extractedCode
    }
  }
  
  return { summary, code }
}

export const EditTool = Tool.define("edit", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to modify"),
    instructions: z.string().describe("Natural language instructions describing what changes to make"),
    relevantFiles: z.array(z.string()).optional().describe("Optional list of relevant files for context to understand how edits should integrate with the broader codebase"),
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
    const substitutedTemplate = await Template.substituteInputs(
      await Template.substitute(EDIT_TEMPLATE),
      {
        format: hasApplyModelForFormat ? Template.Format.Snippet : Template.Format.Diff,
        example,
      }
    )
    const systemLines = substitutedTemplate.split(/\n+/).filter(l => l.trim().length > 0)
    const systemMsgs = systemLines.map(l => ({ role: "system" as const, content: l }))
    // Build contextual messages for target + relevant files
    const fileMessages = [] as { role: "user"; content: string }[]
    fileMessages.push({ role: "user", content: `// File: ${path.relative(Instance.directory, filePath)}\n${contentOld}` })
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
    const isReject = !code || code.trim() === "" || /^\s*(?:\[?no\s*changes?]?|n\/a|null|undefined|#|\/\/|<!--).*$/i.test(code.trim())
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
    
    const { diagnostics } = await handleDiagnosticsAndFileWrite(filePath, result.contentNew, ctx)
    
    return {
      metadata: {
        diagnostics,
        diff: result.diff,
      },
      title: `${path.relative(Instance.worktree, filePath)}`,
      output: summary || "Edit applied successfully",
    }
  },
})

// Import all the replacer functions and types from original edit.ts
export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  // Handle empty strings
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    // Look for the matching last line after this first line
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j })
        break // Only match the first occurrence of the last line
      }
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)

  // Handle single line matches
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      // Only check for substring matches if the full line doesn't match
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        // Find the actual substring in the original line that matches
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch (e) {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n")
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "'":
          return "'"
        case '"':
          return '"'
        case "`":
          return "`"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        case "$":
          return "$"
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  // Try direct match with unescaped find string
  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  // Also try finding escaped versions in content that match unescaped find
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  // This replacer yields all exact matches, allowing the replace function
  // to handle multiple occurrences based on replaceAll parameter
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) {
    // Need at least 3 lines to have meaningful context
    return
  }

  // Remove trailing empty line if present
  if (findLines[findLines.length - 1] === "") {
    findLines.pop()
  }

  const contentLines = content.split("\n")

  // Extract first and last lines as context anchors
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  // Find blocks that start and end with the context anchors
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    // Look for the matching last line
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        // Found a potential context block
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")

        // Check if the middle content has reasonable similarity
        // (simple heuristic: at least 50% of non-empty lines should match when trimmed)
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break // Only match the first occurrence
          }
        }
        break
      }
    }
  }
}

function trimDiff(diff: string): string {
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

// Shared function to handle LSP diagnostics and file writing
async function handleDiagnosticsAndFileWrite(filePath: string, contentNew: string, ctx: any) {
  await LSP.touchFile(filePath, true)
  const diagnostics = await LSP.diagnostics()
  
  // Check for errors in the target file
  const fileErrors = diagnostics[filePath]?.filter((item) => item.severity === 1) || []
  
  if (fileErrors.length > 0) {
    const errorMessage = `File has errors after edit:\n${fileErrors.map(LSP.Diagnostic.pretty).join("\n")}`
    throw new Error(errorMessage)
  }

  // Write the modified content
  await Bun.write(filePath, contentNew)
  await Bus.publish(File.Event.Edited, {
    file: filePath,
  })
  FileTime.read(ctx.sessionID, filePath)

  return { diagnostics }
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("oldString and newString must be different")
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    // BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    // TrimmedBoundaryReplacer,
    // ContextAwareReplacer,
    // MultiOccurrenceReplacer,
  ]) {
    for (const search of Array.from(replacer(content, oldString))) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) {
        return content.replaceAll(search, newString)
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error("oldString not found in content")
  }
  throw new Error(
    "oldString found multiple times and requires more code context to uniquely identify the intended match",
  )
}


// Apply edit output using apply agent
async function applyEditOutput(editOutput: string, summary: string, ctx: any, filePath: string, contentOld: string) {
  const agent = await Agent.get(ctx.agent)
  const applyAgent = await Agent.get("apply")
  // Silent fallback if no apply agent or model
  const modelInfo = applyAgent?.model
    ? await Provider.getModel(applyAgent.model.providerID, applyAgent.model.modelID)
    : await (async () => {
        const def = await Provider.defaultModel()
        return Provider.getModel(def.providerID, def.modelID)
      })()
  const rawPrompt = applyAgent?.prompt ?? ""
  const system = await Template.substitute(rawPrompt)

  let contentNew: string | undefined
  // Provider/model specific application
  // Morph: model-specific (can appear under multiple providers)
  if (modelInfo.modelID.startsWith("morph-v3")) {
    // morph style: single user message with xml-like tags
    const applyMsg = `<instruction>${summary || "Apply edit"}</instruction>\n<code>${contentOld}</code>\n<update>${editOutput}</update>`
    const gen = await generateText({
      model: modelInfo.language,
      temperature: 0,
      maxRetries: 5,
      messages: [ { role: "user", content: applyMsg } ],
    })
    contentNew = extractCodeFromMarkdown(gen.text)
  } else if (modelInfo.providerID === "relace" && modelInfo.modelID === "relace-apply") {
    // relace apply endpoint expects initialCode + editSnippet JSON; treat editOutput as snippet
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
      // swallow and fallback
    }
  }

  if (!contentNew) {
    const userContent = `Apply the following changes to the original file content and return ONLY the full updated file content.\n\nFile: ${path.relative(Instance.directory, filePath)}\n\n--- ORIGINAL START ---\n${contentOld}\n--- ORIGINAL END ---\n\n--- CHANGES START ---\n${editOutput}\n--- CHANGES END ---`
    const gen = await generateText({
      model: modelInfo.language,
      temperature: 0,
      maxRetries: 5,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    })
    contentNew = extractCodeFromMarkdown(gen.text)
  }

  // Create diff for permission check
  const diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
  
  if (agent.permission.edit === "ask") {
    await Permission.ask({
      type: "edit",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      title: "Edit this file: " + filePath,
      metadata: {
        filePath,
        diff,
      },
    })
  }

  return { contentNew, diff }
}

// Parse fuzzy diff output to extract oldString and newString
function parseFuzzyDiff(output: string): { oldString: string; newString: string } {
  // First extract code from markdown if present
  const extractedOutput = extractCodeFromMarkdown(output)
  const lines = extractedOutput.split('\n')
  let oldString = ""
  let newString = ""
  
  // Try multiple patterns to extract old and new code sections
  
  // Pattern 1: Look for unified diff format
  if (extractedOutput.includes('@@') && (extractedOutput.includes('-') || extractedOutput.includes('+'))) {
    for (const line of lines) {
      if (line.startsWith('-') && !line.startsWith('---')) {
        oldString += line.substring(1) + '\n'
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        newString += line.substring(1) + '\n'
      }
    }
  }
  
  // Pattern 2: Look for explicit old/new sections
  if (!oldString || !newString) {
    let inOld = false
    let inNew = false
    
    for (const line of lines) {
      const trimmed = line.trim().toLowerCase()
      
      if (trimmed.includes('old:') || trimmed.includes('replace:') || trimmed.includes('before:') || trimmed.includes('from:')) {
        inOld = true
        inNew = false
        continue
      }
      if (trimmed.includes('new:') || trimmed.includes('with:') || trimmed.includes('after:') || trimmed.includes('to:')) {
        inOld = false
        inNew = true
        continue
      }
      
      if (inOld && !trimmed.startsWith('##') && !trimmed.includes(':')) {
        oldString += line + '\n'
      } else if (inNew && !trimmed.startsWith('##') && !trimmed.includes(':')) {
        newString += line + '\n'
      }
    }
  }
  
  // Pattern 3: Look for code blocks with context
  if (!oldString || !newString) {
    const codeBlocks = []
    let inCodeBlock = false
    let currentBlock = ""
    
    for (const line of lines) {
      if (line.trim().startsWith('```')) {
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
        currentBlock += line + '\n'
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
    newString: newString.trim()
  }
}

// Apply a diff to content to get the modified content
function applyDiffToContent(originalContent: string, diff: string): string {
  const lines = originalContent.split('\n')
  const diffLines = diff.split('\n')
  
  // Simple diff application - handles basic unified diff format
  let result = [...lines]
  let lineOffset = 0
  
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i]
    
    if (line.startsWith('@@')) {
      // Parse hunk header to get line numbers
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/)
      if (match) {
        lineOffset = parseInt(match[1]) - 1 // Convert to 0-based index
      }
      continue
    }
    
    if (line.startsWith('-') && !line.startsWith('---')) {
      // Remove line
      const lineContent = line.substring(1)
      const index = result.findIndex((l, idx) => idx >= lineOffset && l === lineContent)
      if (index !== -1) {
        result.splice(index, 1)
        lineOffset = index
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      // Add line
      const lineContent = line.substring(1)
      result.splice(lineOffset, 0, lineContent)
      lineOffset++
    } else if (line.startsWith(' ')) {
      // Context line - advance offset
      lineOffset++
    }
  }
  
  return result.join('\n')
}

// Use traditional diff method - edit output should be a proper diff
async function diffEditOutput(editOutput: string, ctx: any, filePath: string, contentOld: string) {
  const agent = await Agent.get(ctx.agent)
  
  // Extract code from markdown code blocks if present
  const extractedCode = extractCodeFromMarkdown(editOutput)
  let diff = extractedCode.trim()
  
  // If the diff doesn't look like a proper diff, try to parse it as fuzzy diff
  if (!diff.includes('@@') && !(diff.includes('-') && diff.includes('+'))) {
    // Fallback to fuzzy parsing if the edit agent didn't output proper diff format
    const { oldString, newString } = parseFuzzyDiff(extractedCode)
    
    if (!oldString || !newString) {
      throw new Error("Edit agent output must be a proper diff format or contain identifiable old and new code sections")
    }
    
    // Use the sophisticated replace function with fuzzy matching
    const contentNew = replace(contentOld, oldString, newString, false)
    diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
  }
  
  // For permission check, we need the actual modified content
  // Parse the diff to apply changes to get contentNew
  const contentNew = applyDiffToContent(contentOld, diff)

  if (agent.permission.edit === "ask") {
    await Permission.ask({
      type: "edit",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      title: "Edit this file: " + filePath,
      metadata: {
        filePath,
        diff,
      },
    })
  }

  return { contentNew, diff }
}