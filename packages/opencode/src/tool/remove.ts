import z from "zod/v4"
import { Tool } from "./tool"
import * as path from "path"
import DESCRIPTION from "./remove.txt"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { FileTime } from "../file/time"
import { Agent } from "../agent/agent"
import { Permission } from "../permission"
import { createTwoFilesPatch } from "diff"
import { trimDiff } from "../util/apply"

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
        type: "edit",
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        title: "Delete file: " + abs,
        metadata: { filePath: abs, diff },
      })
    }

    try {
      await (Filesystem as any).remove?.(abs)
    } catch {
      /* ignore */
    }
    try {
      await Bun.write(abs, "")
    } catch {}
    FileTime.read(ctx.sessionID, abs)
    return { title: path.relative(Instance.worktree, abs), metadata: { filePath: abs }, output: "File removed" }
  },
})
