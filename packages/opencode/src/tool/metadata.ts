/**
 * Typed metadata structures for all tools
 * Types are structurally distinct for TypeScript inference
 * Kind/type info is added when serializing to UI with ``` markers
 */

// Output interface - each type knows how to serialize itself
export interface ToolOutput {
  /** Serialize to formatted string for TUI display (includes ``` markers for code/diff) */
  serialize(): string
}

// Text output - plain text without formatting
export class TextOutput implements ToolOutput {
  constructor(private readonly text: string) {}

  serialize(): string {
    return this.text
  }
}

// Code output - formatted as code block with syntax highlighting
export class CodeOutput implements ToolOutput {
  constructor(
    private readonly code: string,
    private readonly language: string
  ) {}

  serialize(): string {
    return `\`\`\`${this.language}\n${this.code}\n\`\`\``
  }
}

// Diff output - formatted as diff block
export class DiffOutput implements ToolOutput {
  constructor(private readonly diff: string) {}

  serialize(): string {
    return `\`\`\`diff\n${this.diff}\n\`\`\``
  }
}

// Error output - error message
export class ErrorOutput implements ToolOutput {
  constructor(private readonly error: Error) {}

  serialize(): string {
    return this.error.message
  }
}

// Factory helpers for creating outputs
export function textOutput(text: string): ToolOutput {
  return new TextOutput(text)
}

export function codeOutput(code: string, language: string): ToolOutput {
  return new CodeOutput(code, language)
}

export function diffOutput(diff: string): ToolOutput {
  return new DiffOutput(diff)
}

export function errorOutput(error: Error): ToolOutput {
  return new ErrorOutput(error)
}

// Legacy compatibility
export type Success = { readonly value: string }
export type ToolError = Error

export function success(value: string): ToolOutput {
  return textOutput(value)
}

export function isToolError(output: ToolOutput): output is ErrorOutput {
  return output instanceof ErrorOutput
}

export function serializeOutput(output: ToolOutput): string {
  return output.serialize()
}

// Content types (structurally distinct)
export type CodeContent = {
  content: string
  language: string
}

export type DiffContent = {
  diff: string
}

export type Content = CodeContent | DiffContent

// Serialize Content to string for display
export function serializeContent(content: Content): string {
  if ("diff" in content) {
    return content.diff
  }
  return content.content
}

// Diagnostics type (LSP diagnostics)
export type Diagnostic = {
  range: {
    start: {
      line: number
      character: number
    }
    end?: {
      line: number
      character: number
    }
  }
  severity: number
  message: string
  code?: string | number
  source?: string
}

export type Diagnostics = Record<string, Diagnostic[]>

// Base metadata shared across tools
export type BaseMetadata = {
  /** Transient status updates during execution */
  status?: string
  /** Unified instruction/explanation field */
  instruction?: string
  /** Retry attempt tracking */
  attempt?: number
  maxRetries?: number
  /** Full untruncated content for expandable display in TUI */
  fullContent?: string
  /** LSP diagnostics per file (crosscutting for code-producing tools) */
  diagnostics?: Diagnostics
  /** Shadow file diff for requirements (crosscutting) */
  shadowDiff?: DiffContent
}

// Tool-specific metadata types

export type PredictMetadata = BaseMetadata & {
  diff?: string
  format?: string
  previewLines?: number
  content?: Content
  error?: string
}

export type EditMetadata = BaseMetadata & {
  diff?: string
  content?: Content
  error?: string
}

export type RequirementsMetadata = BaseMetadata

export type CreateRequirementsMetadata = BaseMetadata

export type UpdateRequirementsMetadata = BaseMetadata

export type ReviewMetadata = BaseMetadata & {
  /** Whether review passed */
  passed: boolean
  /** Review summary text */
  summary?: string
  /** Suggestions for improvement */
  suggestions?: string
}

export type ReadMetadata = BaseMetadata & {
  /** Preview of file content */
  preview: string
  /** Whether file was auto-summarized */
  summarized: boolean
  /** Total line count */
  totalLines: number
}

export type SymbolMetadata = BaseMetadata & {
  /** Number of symbols found */
  count: number
  /** Error indicator for no LSP */
  error?: "no_lsp"
}

export type GrepMetadata = BaseMetadata & {
  /** Number of matches */
  matches: number
  /** Files searched */
  filesSearched?: number
}

export type GlobMetadata = BaseMetadata & {
  /** Number of files found */
  count: number
}

export type BashMetadata = BaseMetadata & {
  /** Exit code */
  exitCode?: number
  /** Background shell ID */
  shellID?: string
}

export type WriteMetadata = BaseMetadata

// Union of all tool metadata types
export type ToolMetadata =
  | PredictMetadata
  | EditMetadata
  | CreateRequirementsMetadata
  | UpdateRequirementsMetadata
  | ReviewMetadata
  | ReadMetadata
  | SymbolMetadata
  | GrepMetadata
  | GlobMetadata
  | BashMetadata
  | WriteMetadata
  | Record<string, any> // Fallback for tools not yet migrated
