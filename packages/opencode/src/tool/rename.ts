import z from "zod/v4"
import * as path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./rename.txt"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Shadow } from "../util/shadow"
import { Agent } from "../agent/agent"
import { Permission } from "../permission"
import { success } from "./metadata"

declare const Bun: any

export const RenameTool = Tool.define("rename", {
  description: DESCRIPTION,
  parameters: z.object({
    oldPath: z.string().describe("Current path to the file"),
    newPath: z.string().describe("New path for the file"),
  }),
  async execute(params, ctx) {
    if (!params.oldPath || !params.newPath) {
      throw new Error("Both oldPath and newPath are required")
    }

    const oldAbs = path.isAbsolute(params.oldPath) ? params.oldPath : path.join(Instance.directory, params.oldPath)
    const newAbs = path.isAbsolute(params.newPath) ? params.newPath : path.join(Instance.directory, params.newPath)

    if (!Filesystem.contains(Instance.directory, oldAbs)) {
      throw new Error(`Old path ${oldAbs} is not in the current working directory`)
    }

    if (!Filesystem.contains(Instance.directory, newAbs)) {
      throw new Error(`New path ${newAbs} is not in the current working directory`)
    }

    // Check if old file exists
    const oldFile = Bun.file(oldAbs)
    const oldStats = await oldFile.stat().catch(() => null)
    if (!oldStats) {
      throw new Error(`File not found: ${oldAbs}`)
    }
    if (oldStats.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${oldAbs}`)
    }

    // Check if new path already exists
    const newFile = Bun.file(newAbs)
    const newExists = await newFile.exists()
    if (newExists) {
      throw new Error(`Destination file already exists: ${newAbs}`)
    }

    // Ensure new directory exists
    const newDir = path.dirname(newAbs)
    try {
      const fsMod = await import("fs/promises")
      await fsMod.mkdir(newDir, { recursive: true })
    } catch (err) {
      // Ignore if already exists
    }

    // Compute relative paths once
    const relativeOld = path.relative(Instance.worktree, oldAbs)
    const relativeNew = path.relative(Instance.worktree, newAbs)

    // Check permission before renaming
    const agent = await Agent.get(ctx.agent)
    if (agent?.permission.edit === "ask") {
      await Permission.ask({
        type: "edit",
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        title: `Rename file: ${relativeOld} → ${relativeNew}`,
      })
    }

    ctx.metadata({
      metadata: {
        status: "Renaming source file",
      },
    })

    // Rename the source file
    try {
      const fsMod = await import("fs/promises")
      await fsMod.rename(oldAbs, newAbs)
    } catch (err) {
      throw new Error(`Failed to rename file: ${err instanceof Error ? err.message : String(err)}`)
    }

    ctx.metadata({
      metadata: {
        status: "Renaming shadow file if it exists",
      },
    })

    // Rename shadow file if it exists
    try {
      await Shadow.rename(oldAbs, newAbs)
    } catch (err) {
      // Log but don't fail if shadow rename fails
      console.warn(`Shadow file rename failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    return {
      title: `Renamed ${relativeOld} → ${relativeNew}`,
      metadata: {
        oldPath: oldAbs,
        newPath: newAbs,
      },
      output: success(`File renamed successfully from ${relativeOld} to ${relativeNew}`),
    }
  },
})
