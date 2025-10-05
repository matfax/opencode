import z from "zod/v4"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
// @ts-ignore
import FILE_SUMMARY_TEMPLATE from "./support/file-summary.txt"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { generateText } from "ai"
import { buildSupportModelParams } from "../session/support-model-params"

const DEFAULT_READ_LIMIT = 200
const MAX_LINE_LENGTH = 2000

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The path to the file to read"),
    limit: z.coerce.number().optional().default(DEFAULT_READ_LIMIT).describe("The number of lines to read"),
    offset: z.coerce.number().optional().default(0).describe("The line number to start reading from (0-based)"),
    query: z.string().optional().describe("Query for the summary model (enables auto-summary)"),
  }),
  key: (p) => {
    return ["read", "a" + (p.query ? "1" : "0"), p.filePath].join("|")
  },
  enableRefresh: (p) => {
    const lim = p.limit ?? DEFAULT_READ_LIMIT
    return lim <= DEFAULT_READ_LIMIT && !p.query
  },
  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.join(process.cwd(), filepath)
    }
    if (!ctx.extra?.["bypassCwdCheck"] && !Filesystem.contains(Instance.directory, filepath)) {
      throw new Error(`File ${filepath} is not in the current working directory`)
    }

    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      const dirEntries = fs.readdirSync(dir)
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }

    const limit = Math.max(params.limit ?? DEFAULT_READ_LIMIT, 1)
    const offset = Math.max(params.offset ?? 0, 0)
    const isImage = isImageFile(filepath)
    if (isImage) throw new Error(`This is an image file of type: ${isImage}\nUse a different tool to process images`)
    const isBinary = await isBinaryFile(filepath, file)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    const lines = await file.text().then((text) => text.split("\n"))

    // Check if auto-summarize should trigger
    const shouldAutoSummarize = !!params.query && !params.offset && lines.length > limit

    if (shouldAutoSummarize) {
      // Get full file content for summarization
      const fullContent = lines.join("\n")

      // Generate summary using the support model
      const userInstruction = `Please summarize the following file content with focus on: ${params.query}\n\nFile: ${path.relative(Instance.worktree, filepath)}\n\n'''${fullContent}'''`

      const { params: supportParams, systemMessages } = await buildSupportModelParams(
        "summary",
        ctx.agent,
        FILE_SUMMARY_TEMPLATE,
        ctx.sessionID,
        filepath,
      )
      const summaryGen = await generateText({
        ...supportParams,
        maxRetries: 3,
        messages: [
          ...systemMessages.map(content => ({ role: "system" as const, content })),
          { role: "user", content: userInstruction },
        ],
      })

      // just warms the lsp client
      LSP.touchFile(filepath, false)
      FileTime.read(ctx.sessionID, filepath)

      return {
        title: `Summary: ${path.relative(Instance.worktree, filepath)} (${lines.length} lines)`,
        output: summaryGen.text,
        metadata: {
          preview: lines.slice(0, 20).join("\n"),
          summarized: true,
          totalLines: lines.length,
        },
      }
    }

    const raw = lines.slice(offset, offset + limit).map((line) => {
      return line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + "..." : line
    })
    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = "<file>\n"
    output += content.join("\n")

    if (lines.length > offset + content.length) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${offset + content.length})`
    }
    output += "\n</file>"

    // just warms the lsp client
    LSP.touchFile(filepath, false)
    FileTime.read(ctx.sessionID, filepath)

    return {
      title: path.relative(Instance.worktree, filepath),
      output,
      metadata: {
        preview,
        summarized: false,
        totalLines: lines.length,
      },
    }
  },
})

function isImageFile(filePath: string): string | false {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "JPEG"
    case ".png":
      return "PNG"
    case ".gif":
      return "GIF"
    case ".bmp":
      return "BMP"
    case ".webp":
      return "WebP"
    default:
      return false
  }
}

async function isBinaryFile(filepath: string, file: Bun.BunFile): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  const stat = await file.stat()
  const fileSize = stat.size
  if (fileSize === 0) return false

  const bufferSize = Math.min(4096, fileSize)
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength === 0) return false
  const bytes = new Uint8Array(buffer.slice(0, bufferSize))

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}
