import { createTwoFilesPatch } from "diff"

/**
 * FileDiff encapsulates file change information with multiple representations
 * Provides access to old/new content, unified diff, and annotated full content
 */
export class FileDiff {
  private readonly _oldContent: string
  private readonly _newContent: string
  private readonly _diff: string
  private readonly _annotated: string | null

  /**
   * Create a FileDiff from old content, new content, and optional diff
   * @param oldContent - Original file content
   * @param newContent - Modified file content
   * @param diff - Optional unified diff (will be generated if not provided)
   * @param filePath - File path for diff header (defaults to "file")
   */
  constructor(oldContent: string, newContent: string, diff?: string, filePath?: string) {
    this._oldContent = oldContent
    this._newContent = newContent

    // Generate diff if not provided
    if (diff) {
      this._diff = diff
    } else {
      const fileName = filePath || "file"
      this._diff = createTwoFilesPatch(fileName, fileName, oldContent, newContent, "", "", { context: 3 })
    }

    // Generate annotated content (full file with inline diff markers)
    this._annotated = this.generateAnnotatedContent()
  }

  /**
   * Original file content before changes
   */
  get oldContent(): string {
    return this._oldContent
  }

  /**
   * Modified file content after changes
   */
  get newContent(): string {
    return this._newContent
  }

  /**
   * Unified diff format showing changes
   */
  get diff(): string {
    return this._diff
  }

  /**
   * Annotated content: complete new file with inline diff markers showing what changed
   * Returns null if annotation generation failed
   *
   * Format example:
   * ```
   * function example() {
   * -  const old = "removed"
   * +  const new = "added"
   *    const unchanged = "same"
   * }
   * ```
   */
  get annotated(): string | null {
    return this._annotated
  }

  /**
   * Check if the diff represents any actual changes
   */
  get hasChanges(): boolean {
    return this._oldContent.trimEnd() !== this._newContent.trimEnd()
  }

  /**
   * Generate annotated content by applying diff markers inline to full file
   * Shows complete file with +/- markers for changed lines
   */
  private generateAnnotatedContent(): string | null {
    if (!this.hasChanges) {
      return this._newContent // No changes, just return new content
    }

    try {
      const newLines = this._newContent.split("\n")
      const result: string[] = []

      // Parse the unified diff to extract hunks
      const hunks = this.parseUnifiedDiff(this._diff)

      if (hunks.length === 0) {
        return null // Failed to parse diff
      }

      let newLineIdx = 0

      for (const hunk of hunks) {
        // Add unchanged lines before this hunk
        while (newLineIdx < hunk.newStart - 1) {
          result.push(`   ${newLines[newLineIdx]}`)
          newLineIdx++
        }

        // Process hunk lines
        for (const line of hunk.lines) {
          if (line.type === "context") {
            result.push(`   ${line.content}`)
            newLineIdx++
          } else if (line.type === "removed") {
            result.push(` - ${line.content}`)
          } else if (line.type === "added") {
            result.push(` + ${line.content}`)
            newLineIdx++
          }
        }
      }

      // Add remaining unchanged lines after all hunks
      while (newLineIdx < newLines.length) {
        result.push(`   ${newLines[newLineIdx]}`)
        newLineIdx++
      }

      return result.join("\n")
    } catch (err) {
      console.warn("Failed to generate annotated content:", err)
      return null
    }
  }

  /**
   * Parse unified diff format into structured hunks
   */
  private parseUnifiedDiff(diff: string): Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: Array<{ type: "context" | "added" | "removed"; content: string }>
  }> {
    const hunks: Array<{
      oldStart: number
      oldLines: number
      newStart: number
      newLines: number
      lines: Array<{ type: "context" | "added" | "removed"; content: string }>
    }> = []

    const lines = diff.split("\n")
    let i = 0

    // Skip header lines (---, +++, index, etc.)
    while (i < lines.length && !lines[i].startsWith("@@")) {
      i++
    }

    while (i < lines.length) {
      const line = lines[i]

      if (line.startsWith("@@")) {
        // Parse hunk header: @@ -oldStart,oldLines +newStart,newLines @@
        const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
        if (!match) {
          i++
          continue
        }

        const oldStart = parseInt(match[1], 10)
        const oldLines = match[2] ? parseInt(match[2], 10) : 1
        const newStart = parseInt(match[3], 10)
        const newLines = match[4] ? parseInt(match[4], 10) : 1

        const hunkLines: Array<{ type: "context" | "added" | "removed"; content: string }> = []
        i++

        // Collect lines until next hunk or end
        while (i < lines.length && !lines[i].startsWith("@@")) {
          const currentLine = lines[i]

          if (currentLine.startsWith("+")) {
            hunkLines.push({ type: "added", content: currentLine.slice(1) })
          } else if (currentLine.startsWith("-")) {
            hunkLines.push({ type: "removed", content: currentLine.slice(1) })
          } else if (currentLine.startsWith(" ")) {
            hunkLines.push({ type: "context", content: currentLine.slice(1) })
          } else if (currentLine === "") {
            // Empty line - could be context
            hunkLines.push({ type: "context", content: "" })
          }
          // Skip lines like "\ No newline at end of file"

          i++
        }

        hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunkLines })
      } else {
        i++
      }
    }

    return hunks
  }

  /**
   * Create FileDiff from just diff and old content (derives new content)
   */
  static fromDiff(diff: string, oldContent: string, filePath?: string): FileDiff {
    const newContent = FileDiff.applyDiff(diff, oldContent)
    return new FileDiff(oldContent, newContent, diff, filePath)
  }

  /**
   * Apply a unified diff to content to get new content
   * Simple implementation - may need refinement for complex diffs
   */
  private static applyDiff(diff: string, oldContent: string): string {
    // This is a simplified implementation
    // For production, consider using a robust library like 'diff' or existing apply logic
    const lines = oldContent.split("\n")
    const diffLines = diff.split("\n")
    const result: string[] = []

    let lineIdx = 0
    let i = 0

    // Skip headers
    while (i < diffLines.length && !diffLines[i].startsWith("@@")) {
      i++
    }

    while (i < diffLines.length) {
      if (diffLines[i].startsWith("@@")) {
        // Parse hunk header
        const match = diffLines[i].match(/@@ -(\d+)/)
        if (match) {
          const hunkStart = parseInt(match[1], 10)
          // Add lines before hunk
          while (lineIdx < hunkStart - 1) {
            result.push(lines[lineIdx])
            lineIdx++
          }
        }
        i++
      } else if (diffLines[i].startsWith("+")) {
        result.push(diffLines[i].slice(1))
        i++
      } else if (diffLines[i].startsWith("-")) {
        lineIdx++ // Skip removed line
        i++
      } else if (diffLines[i].startsWith(" ")) {
        result.push(diffLines[i].slice(1))
        lineIdx++
        i++
      } else {
        i++
      }
    }

    // Add remaining lines
    while (lineIdx < lines.length) {
      result.push(lines[lineIdx])
      lineIdx++
    }

    return result.join("\n")
  }
}
