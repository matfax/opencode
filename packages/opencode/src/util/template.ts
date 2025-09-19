import * as path from "path"
import * as os from "os"
import { parse as parseJsonc, type ParseError as JsoncParseError, printParseErrorCode } from "jsonc-parser"
import { z } from "zod"
import { Instance } from "../project/instance"

declare const Bun: any

export namespace Template {
  export enum Format {
    Snippet = "snippet",
    Diff = "diff",
  }
  /**
   * Process template variables in text, supporting {env:VARIABLE} and {file:path} substitutions.
   * This is the same processing used in config files.
   */
  export async function substitute(text: string, basePath?: string): Promise<string> {
    // Process environment variables
    text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })

    // Process file references
    const fileMatches = text.match(/\{file:[^}]+\}/g)
    if (fileMatches) {
      const baseDir = basePath || Instance.directory
      const lines = text.split("\n")

      for (const match of fileMatches) {
        const lineIndex = lines.findIndex((line) => line.includes(match))
        if (lineIndex !== -1 && lines[lineIndex].trim().startsWith("//")) {
          continue // Skip if line is commented
        }
        let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
        if (filePath.startsWith("~/")) {
          filePath = path.join(os.homedir(), filePath.slice(2))
        }
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
        const fileContent = (
          await Bun.file(resolvedPath)
            .text()
            .catch((error: any) => {
              const errMsg = `bad file reference: "${match}"`
              if (error.code === "ENOENT") {
                throw new Error(errMsg + ` ${resolvedPath} does not exist`)
              }
              throw new Error(errMsg + ` ${error.message}`)
            })
        ).trim()
        // escape newlines/quotes, strip outer quotes
        text = text.replace(match, JSON.stringify(fileContent).slice(1, -1))
      }
    }

    return text
  }

  /**
   * Parse JSONC text, report errors, and validate against Zod schema.
   * @param text JSONC content after substitution
   * @param schema Zod schema to validate parsed data
   * @param configFilepath Path for error reporting
   */
  export function processConfig<T>(
    text: string,
    schema: z.ZodType<T>,
    configFilepath: string
  ): T {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const detail = errors
        .map((e) => {
          const before = text.substring(0, e.offset).split("\n")
          const line = before.length
          const col = before[before.length - 1].length + 1
          const probLine = lines[line - 1] || ""
          const err = `${printParseErrorCode(e.error)} at line ${line}, column ${col}`
          return probLine
            ? `${err}\n  Line ${line}: ${probLine}\n${"".padStart(col + 5)}^`
            : err
        })
        .join("\n")
      throw new Error(`Config JSONC error in ${configFilepath}:\n${detail}`)
    }
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
      throw new Error(`Config validation error in ${configFilepath}: ${issues}`)
    }
    return parsed.data
  }
  
  /**
   * Load, substitute, parse, validate, and post-process a config file.
   * Handles reading, {env:}/{file:} placeholders, JSONC, Zod, schema injection, and plugin resolution.
   * @param filepath Path to config file
   * @param schema Zod schema for validation
   */
  export async function loadConfig(
    filepath: string,
    schema: z.ZodTypeAny
  ): Promise<any> {
    // Read file text, return empty config if missing
    let raw: string
    try {
      raw = await Bun.file(filepath).text()
    } catch (err: any) {
      if (err.code === "ENOENT") return {}
      throw err
    }
    // Substitute {env:}/{file:}
    const substituted = await substitute(raw, path.dirname(filepath))
    // Parse JSONC and validate via Zod
    const data: any = processConfig(substituted, schema, filepath)
    // Inject schema field if absent
    if (data.$schema == null) {
      data.$schema = "https://opencode.ai/config.json"
      await Bun.write(filepath, JSON.stringify(data, null, 2))
    }
    // Resolve plugin paths
    if (Array.isArray(data.plugin)) {
      data.plugin = data.plugin.map((p: any) => {
        try {
          return import.meta.resolve(p, filepath)
        } catch {
          return p
        }
      })
    }
    return data
  }

  /**
   * Load and process template file with substitutions
   */
  export async function load(templatePath: string, basePath?: string): Promise<string> {
    const resolvedPath = path.isAbsolute(templatePath) ? templatePath : path.resolve(basePath || Instance.directory, templatePath)
    const template = await Bun.file(resolvedPath).text()
  return substitute(template, basePath)
  }

  /**
   * Process input placeholders in template text
   */
  export async function substituteInputs(
    text: string,
    inputs: Record<string, string | number | boolean | undefined>
  ): Promise<string> {
    let result = text
    for (const [key, value] of Object.entries(inputs)) {
      const safeVal = value == null ? "" : String(value)
      const pattern = new RegExp(`\\{input:${key}\\}`, 'g')
      result = result.replace(pattern, safeVal)
    }
    return result
  }
}