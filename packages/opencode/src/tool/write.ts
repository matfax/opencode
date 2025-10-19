import { success } from "./metadata"
import z from "zod/v4"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import DESCRIPTION from "./write.txt"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { handleDiagnosticsAndFileWrite } from "../util/apply"
import { Shadow } from "../util/shadow"

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("Path to the file to write"),
    content: z.string().describe("The content to write to the file"),
    motivation: z
      .string()
      .optional()
      .describe("Brief description of file purpose and goals (for new code files only)"),
    symbols: z
      .array(
        z.object({
          name: z.string().describe("Symbol name (class, function, interface, enum - no variables)"),
          purpose: z.string().describe("Why this symbol exists and what it does"),
          requirements: z.array(z.string()).optional().describe("Specific requirements for this symbol"),
        })
      )
      .optional()
      .describe("Symbols in the file with their purposes and requirements (for new code files only)"),
  }),
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    if (!Filesystem.contains(Instance.directory, filepath)) {
      throw new Error(`File ${filepath} is not in the current working directory`)
    }

    const file = Bun.file(filepath)
    const exists = await file.exists()
    if (exists) await FileTime.assert(ctx.sessionID, filepath)

    // Use centralized helper for diagnostics, permission check, and file writing
    const { diagnostics, absolutePath } = await handleDiagnosticsAndFileWrite(filepath, params.content, {
      ctx,
      type: "write",
      title: exists ? "Overwrite this file: " + filepath : "Create new file: " + filepath,
    })

    // Create shadow file if motivation or symbols provided and file doesn't have shadow yet
    if (params.motivation || params.symbols) {
      const shadowExists = await Shadow.exists(filepath)
      if (!shadowExists) {
        const shadowTemplate = Shadow.createTemplate(filepath, params.motivation, params.symbols)
        await Shadow.write(filepath, shadowTemplate)
      }
    }

    let output = ""
    for (const [file, issues] of Object.entries(diagnostics)) {
      if (issues.length === 0) continue
      if (file === absolutePath) {
        output += `\nThe target file has diagnostic errors, please fix\n<file_diagnostics>\n${issues.map(LSP.Diagnostic.pretty).join("\n")}\n</file_diagnostics>\n`
        continue
      }
      output += `\n<project_diagnostics>\n${file}\n${issues.map(LSP.Diagnostic.pretty).join("\n")}\n</project_diagnostics>\n`
    }

    return {
      title: path.relative(Instance.worktree, filepath),
      metadata: {
        diagnostics,
        fullContent: params.content,
      },
      output: success(output),
    }
  },
})
