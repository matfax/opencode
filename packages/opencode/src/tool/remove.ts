import z from "zod/v4"
import { Tool } from "./tool"
import * as path from "path"
import DESCRIPTION from "./remove.txt"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Agent } from "../agent/agent"
import { Permission } from "../permission"
import { createTwoFilesPatch } from "diff"
import { trimDiff } from "../util/apply"
import { Shadow } from "../util/shadow"

declare const Bun: any

export const RemoveTool = Tool.define("remove", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("Path to the file to remove"),
  }),
  async execute(params, ctx) {
    if (!params.filePath) throw new Error("filePath required")
    const abs = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    if (!Filesystem.contains(Instance.directory, abs)) throw new Error("File path escapes project root")
    const f = Bun.file(abs)
    const st = await f.stat().catch(() => null)
    if (!st) throw new Error("File not found")
    if (st.isDirectory()) throw new Error("Path is a directory, not a file")
    const original = await f.text()

    const agent = await Agent.get(ctx.agent)
    if (agent?.permission.edit === "ask") {
      const diff = trimDiff(createTwoFilesPatch(abs, abs, original, ""))
      await Permission.ask({
        type: "write",
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        title: "Delete file: " + abs,
        metadata: { filePath: abs, diff },
      })
    }

    let deleted = false
    try {
      if ((Filesystem as any).remove) {
        await (Filesystem as any).remove(abs)
        deleted = true
      }
    } catch {}
    if (!deleted) {
      try {
        const fsMod = await import("fs/promises")
        await fsMod.rm(abs, { force: true })
        deleted = true
      } catch {}
    }

    // Delete shadow file if source was deleted successfully
    if (deleted) {
      try {
        await Shadow.remove(abs)
      } catch (err) {
        // Log but don't fail if shadow removal fails
        console.warn(`Shadow file removal failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return {
      title: path.relative(Instance.worktree, abs),
      metadata: { filePath: abs, deleted },
      output: deleted ? "File removed" : "File removal attempted (could not confirm)",
    }
  },
})
