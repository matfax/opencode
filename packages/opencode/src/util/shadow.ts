import * as path from "path"
import { Instance } from "../project/instance"
import { createTwoFilesPatch } from "diff"
import { trimDiff } from "./apply"
import { Filesystem } from "./filesystem"

declare const Bun: any

const SHADOW_DIR = ".opencode/shadows"

/**
 * Shadow file utilities for managing metadata files that track
 * requirements, contracts, and motivations for source files
 */
export namespace Shadow {
  /**
   * Convert source file path to shadow file path
   * e.g., src/tool/edit.ts -> .opencode/shadows/src/tool/edit.md
   * Validates that source path is within project directory
   */
  export function toShadowPath(sourcePath: string): string {
    // Resolve to absolute path first
    const absolutePath = path.isAbsolute(sourcePath) ? sourcePath : path.join(Instance.directory, sourcePath)

    // Validate that the path is within the project directory
    if (!Filesystem.contains(Instance.directory, absolutePath)) {
      throw new Error(`Cannot create shadow file for path outside project: ${sourcePath}`)
    }

    const relativePath = path.relative(Instance.directory, absolutePath)

    // Replace file extension with .md
    const shadowRelative = relativePath.replace(/\.[^.]+$/, ".md")
    return path.join(Instance.directory, SHADOW_DIR, shadowRelative)
  }

  /**
   * Convert shadow file path to source file path
   * e.g., .opencode/shadows/src/tool/edit.md -> src/tool/edit.ts
   */
  export function toSourcePath(shadowPath: string): string {
    const relativePath = path.isAbsolute(shadowPath)
      ? path.relative(path.join(Instance.directory, SHADOW_DIR), shadowPath)
      : shadowPath

    // Find original extension by checking file system
    const baseWithoutExt = relativePath.replace(/\.md$/, "")
    // Note: This is a simplified approach. In practice, we'd need to track
    // the original extension or infer from context
    return path.join(Instance.directory, baseWithoutExt)
  }

  /**
   * Check if a shadow file exists for the given source file
   */
  export async function exists(sourcePath: string): Promise<boolean> {
    const shadowPath = toShadowPath(sourcePath)
    const file = Bun.file(shadowPath)
    return await file.exists()
  }

  /**
   * Read shadow file content, returns empty string if doesn't exist
   */
  export async function read(sourcePath: string): Promise<string> {
    const shadowPath = toShadowPath(sourcePath)
    const file = Bun.file(shadowPath)
    const fileExists = await file.exists()
    if (!fileExists) return ""
    return await file.text()
  }

  /**
   * Write shadow file content, creating directories as needed
   */
  export async function write(sourcePath: string, content: string): Promise<void> {
    const shadowPath = toShadowPath(sourcePath)
    const dir = path.dirname(shadowPath)

    // Create shadow directory structure
    try {
      const fsMod = await import("fs/promises")
      await fsMod.mkdir(dir, { recursive: true })
    } catch (err) {
      // Ignore if already exists
    }

    await Bun.write(shadowPath, content)
  }

  /**
   * Delete shadow file if it exists
   */
  export async function remove(sourcePath: string): Promise<boolean> {
    const shadowPath = toShadowPath(sourcePath)
    const file = Bun.file(shadowPath)
    const fileExists = await file.exists()
    if (!fileExists) return false

    try {
      const fsMod = await import("fs/promises")
      await fsMod.rm(shadowPath, { force: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * Rename shadow file along with source file
   */
  export async function rename(oldSourcePath: string, newSourcePath: string): Promise<void> {
    const oldShadowPath = toShadowPath(oldSourcePath)
    const newShadowPath = toShadowPath(newSourcePath)

    const file = Bun.file(oldShadowPath)
    const fileExists = await file.exists()
    if (!fileExists) return

    // Read, update header, write to new location, delete old
    let content = await file.text()

    // Update header path (first line should be # path)
    const lines = content.split("\n")
    if (lines[0]?.startsWith("# ")) {
      const relativeNew = path.relative(Instance.directory, newSourcePath)
      lines[0] = `# ${relativeNew}`
      content = lines.join("\n")
    }

    // Ensure new directory exists
    const newDir = path.dirname(newShadowPath)
    try {
      const fsMod = await import("fs/promises")
      await fsMod.mkdir(newDir, { recursive: true })
    } catch {}

    // Write to new location
    await Bun.write(newShadowPath, content)

    // Delete old
    try {
      const fsMod = await import("fs/promises")
      await fsMod.rm(oldShadowPath, { force: true })
    } catch {}
  }

  /**
   * Generate a diff between old and new shadow content
   * Uses same graceful diff format as edit diffs
   */
  export function diff(oldContent: string, newContent: string, sourcePath: string): string {
    const shadowPath = toShadowPath(sourcePath)
    const rawDiff = createTwoFilesPatch(shadowPath, shadowPath, oldContent, newContent)
    return trimDiff(rawDiff)
  }

  /**
   * Create initial shadow file template with file-level motivation and symbol-specific requirements
   */
  export function createTemplate(
    sourcePath: string,
    motivation?: string,
    symbols?: Array<{ name: string; purpose: string; requirements?: string[] }>,
  ): string {
    const relativePath = path.relative(Instance.directory, sourcePath)
    const purposeText = motivation || "Purpose and motivation for this file."

    let symbolSections = ""
    if (symbols && symbols.length > 0) {
      symbolSections = symbols
        .map((sym) => {
          const requirementsList =
            sym.requirements && sym.requirements.length > 0
              ? "\n\n" + sym.requirements.map((req) => `- ${req}`).join("\n")
              : ""
          return `\n\n## ${sym.name}\n\n${sym.purpose}${requirementsList}`
        })
        .join("")
    }

    return `# ${relativePath}\n\n${purposeText}${symbolSections}`
  }

  /**
   * Check if shadow diff contains requirement removals
   * In unified diff format, removed lines start with "-" (but not "---" header lines)
   */
  export function hasRemovals(shadowDiff: string): boolean {
    const lines = shadowDiff.split("\n")
    return lines.some(
      (line) =>
        // Line starts with "-" for removal in unified diff
        line.startsWith("-") &&
        // Exclude diff header lines (---)
        !line.startsWith("---") &&
        // Must have content after the "-"
        line.trim().length > 1,
    )
  }
}
