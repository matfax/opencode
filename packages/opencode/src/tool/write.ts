import z from "zod/v4"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import DESCRIPTION from "./write.txt"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { handleDiagnosticsAndFileWrite } from "../util/apply"

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
    content: z.string().describe("The content to write to the file"),
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
        filepath,
        exists: exists,
      },
      output,
    }
  },
})
