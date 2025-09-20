import z from "zod/v4"
import path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { Instance } from "../project/instance"
import DESCRIPTION from "./symbol.txt"

export const SymbolTool = Tool.define("symbol", {
  description: DESCRIPTION,
  parameters: z.object({
    name: z.string().describe("Symbol name to look for (class/function/etc.)"),
    fuzzy: z.boolean().describe("Enable substring/camelCase fuzzy match").optional(),
    limit: z.number().describe("Max workspace symbols to scan (default 200, 0 = unlimited)").optional().default(200),
    context: z.number().describe("Extra context lines around definition").optional().default(0),
    numbering: z.boolean().describe("Prefix lines with numbers (default false)").optional(),
  }),
  async execute(args) {

    // Check if any LSP clients are available
    const lspState = await LSP.init()
    if (lspState.clients.length === 0) {
      return {
        title: args.name,
        metadata: { count: 0, fuzzy: !!args.fuzzy, error: "no_lsp" },
        output:
          "No LSP servers are configured or running. Symbol search requires a language server for the target file type. Please configure an LSP server in your opencode configuration.",
      }
    }

    const symbols = await LSP.workspaceSymbol(args.name, args.limit)
    const results: {
      name: string
      kind: number
      file: string
      start: number
      end: number
      code: string
    }[] = []

    function matches(target: string) {
      const a = target.toLowerCase()
      const b = args.name.toLowerCase()
      if (!args.fuzzy) return a === b
      if (a.includes(b)) return true
      const segs = target.split(/[^A-Za-z0-9]/).filter(Boolean)
      return segs.some((s) => s.toLowerCase().startsWith(b))
    }

    for (const sym of symbols) {
      const uri = sym.location.uri
      if (!uri.startsWith("file://")) continue
      const fileAbs = uri.replace("file://", "")
      await LSP.touchFile(fileAbs, false)
      const docSymbols = await LSP.documentSymbol(uri)
      const candidates: any[] = (docSymbols as any[]).filter((d) => matches(d.name))
      if (!candidates.length && matches(sym.name)) {
        candidates.push({
          name: sym.name,
          kind: sym.kind,
          range: sym.location.range,
          selectionRange: sym.location.range,
        })
      }
      if (!candidates.length) continue
      const text = await Bun.file(fileAbs).text()
      const lines = text.split("\n")
      for (const c of candidates) {
        const range = c.range ?? c.location?.range
        if (!range || !range.start || !range.end) continue
        const start = range.start.line
        const end = range.end.line
        const from = Math.max(0, start - args.context)
        const to = Math.min(lines.length - 1, end + args.context)
        const slice = lines.slice(from, to + 1)
        const body = args.numbering
          ? slice.map((ln, i) => `${(from + 1 + i).toString().padStart(5, "0")}| ${ln}`).join("\n")
          : slice.join("\n")
        results.push({
          name: c.name,
          kind: c.kind,
          file: path.relative(Instance.worktree, fileAbs),
          start,
          end,
          code: body,
        })
      }
    }

    const output =
      results.length === 0
        ? "No symbols found"
        : results
            .map((r) => {
              return [
                `name: ${r.name}`,
                `file: ${r.file}:${r.start + 1}`,
                "----",
                r.code,
              ].join("\n")
            })
            .join("\n\n")

    return {
      title: args.name,
      metadata: {
        count: results.length,
        fuzzy: !!args.fuzzy,
        ...(lspState.clients.length === 0 ? { error: "no_lsp" } : {}),
      },
      output,
    }
  },
})
