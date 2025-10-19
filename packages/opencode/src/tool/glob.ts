import z from "zod/v4"
import path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./glob.txt"
import { Ripgrep } from "../file/ripgrep"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"
import { success } from "./metadata"

const DEFAULT_EXPIRATION = 5 // expire after 5 messages

const log = Log.create({ service: "glob" })

export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
      ),
  }),
  key: (p) => ["glob", p.path || ".", p.pattern].join("|"),
  expireAfter: (_p) => DEFAULT_EXPIRATION,
  async execute(params) {
    // Validate pattern manually
    if (!params.pattern || params.pattern.trim().length === 0) {
      log.error("Invalid pattern", { pattern: params.pattern })
      throw new Error("Pattern cannot be empty or whitespace")
    }
    if (params.pattern.length > 500) {
      log.error("Pattern too long", { length: params.pattern.length })
      throw new Error(`Pattern is too long (${params.pattern.length} characters, max 500)`)
    }

    const defaultDirectory = Instance.directory.trim()
    const rawPath = params.path?.trim()

    // Handle empty path parameter properly
    let search = rawPath && rawPath.length > 0 ? rawPath : defaultDirectory
    search = path.isAbsolute(search) ? search : path.resolve(defaultDirectory, search)

    // Security: Ensure the search path is within the project directory
    if (!Filesystem.contains(Instance.directory, search)) {
      log.error("Path containment check failed", {
        requestedPath: params.path,
        resolvedPath: search,
        projectDir: Instance.directory,
      })
      throw new Error(`Path ${search} is not in the current working directory`)
    }

    log.info("Starting glob search", {
      pattern: params.pattern,
      searchPath: path.relative(Instance.directory, search),
    })

    const limit = 100
    const files = []
    const errors: string[] = []
    let truncated = false
    let skippedOutsideDir = 0

    for (const file of await Ripgrep.files({
      cwd: search,
      glob: [params.pattern],
    })) {
      if (files.length >= limit) {
        truncated = true
        break
      }
      const full = path.resolve(search, file)

      // Security: Validate that resolved path is still within the project directory
      if (!Filesystem.contains(Instance.directory, full)) {
        skippedOutsideDir++
        continue
      }

      try {
        const stats = await Bun.file(full).stat()
        files.push({
          path: full,
          mtime: stats.mtime.getTime(),
        })
      } catch (err) {
        // Track stat failures and log them
        const relativePath = path.relative(Instance.directory, full)
        const errorMessage = err instanceof Error ? err.message : String(err)
        errors.push(`${relativePath}: ${errorMessage}`)
        log.warn("Failed to stat file", { file: relativePath, error: errorMessage })
      }
    }
    files.sort((a, b) => b.mtime - a.mtime)

    const output = []
    if (files.length === 0 && errors.length === 0) output.push("No files found")
    if (files.length > 0) {
      output.push(...files.map((f) => f.path))
      if (truncated) {
        output.push("")
        output.push("(Results are truncated. Consider using a more specific path or pattern.)")
      }
    }

    // Report any errors encountered during file scanning
    if (errors.length > 0) {
      output.push("")
      output.push(`Warning: Failed to access ${errors.length} file(s):`)
      output.push(...errors.map((e) => `  - ${e}`))
    }

    // Report security issues if files were skipped
    if (skippedOutsideDir > 0) {
      log.error("Security violation: files outside project directory", {
        skippedCount: skippedOutsideDir,
        searchPath: search,
        projectDir: Instance.directory,
        pattern: params.pattern,
      })
      throw new Error(
        `Security violation: ${skippedOutsideDir} file(s) outside project directory were found. This may indicate:\n` +
          `- Symlinks pointing outside the project\n` +
          `- Path traversal attempts\n` +
          `- Filesystem configuration issues\n\n` +
          `Search path: ${search}\n` +
          `Project directory: ${Instance.directory}`,
      )
    }

    log.info("Glob search completed", {
      filesFound: files.length,
      errorCount: errors.length,
      truncated,
      skippedOutsideDir,
    })

    return {
      title: path.relative(Instance.worktree, search),
      metadata: {
        count: files.length,
        truncated,
        errors: errors.length > 0 ? errors : undefined,
      },
      output: success(output.join("\n")),
    }
  },
})
