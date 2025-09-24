import * as os from "os"
import { $ } from "bun"

// Classification arrays (exported in case other tools want finer control)
export const COMMON_TOOLS = [
  "git",
  "docker",
  "node",
  "npm",
  "yarn",
  "pnpm",
  "python",
  "java",
  "go",
  "rustc",
  "bun",
  "make"
]

export const LINUX_MAC_TOOLS = [
  "curl",
  "wget",
  "brew",
  "apt",
  "yum",
  "pacman"
]

export const WINDOWS_TOOLS = [
  "winget",
  "choco"
]

export type ToolInfo = { available: boolean; version?: string; path?: string }

export function getDefaultTools(): string[] {
  const p = os.platform()
  if (p === "win32") return [...COMMON_TOOLS, ...WINDOWS_TOOLS]
  return [...COMMON_TOOLS, ...LINUX_MAC_TOOLS]
}

async function locate(command: string): Promise<string | undefined> {
  const p = os.platform()
  const cmd = p === "win32" ? $`where ${command}` : $`which ${command}`
  const r = await cmd.quiet().nothrow()
  if (r.exitCode !== 0) return undefined
  const t = await r.text()
  const v = t.trim()
  if (!v) return undefined
  if (v.includes("not found")) return undefined
  return v.split(/\r?\n/)[0].trim()
}

async function version(command: string): Promise<string | undefined> {
  const attempts = ["--version", "version", "-version"]
  for (const a of attempts) {
    const r = await $`${{ raw: `${command} ${a}` }}`.quiet().nothrow()
    if (r.exitCode !== 0) continue
    const t = (await r.text()).trim()
    if (!t) continue
    return t.split(/\r?\n/)[0].trim()
  }
}

async function checkOne(command: string): Promise<ToolInfo> {
  const path = await locate(command)
  if (!path) return { available: false }
  const ver = await version(command)
  return { available: true, path, version: ver }
}

export async function checkToolAvailability(tools: string[]): Promise<Map<string, ToolInfo>> {
  const map = new Map<string, ToolInfo>()
  for (const t of tools) {
    if (t.includes("*") || t.includes("?")) {
      const base = t.replace(/[*?]/g, "")
      if (!base) {
        map.set(t, { available: false })
        continue
      }
      const info = await checkOne(base)
      map.set(t, info)
      continue
    }
    const info = await checkOne(t)
    map.set(t, info)
  }
  return map
}

export function formatToolAvailability(map: Map<string, ToolInfo>, subset?: string[]): string {
  const include = subset && subset.length > 0 ? subset : Array.from(map.keys())
  const avail: string[] = []
  const missing: string[] = []
  for (const k of include) {
    const info = map.get(k)
    if (!info) {
      missing.push(k)
      continue
    }
    if (!info.available) {
      missing.push(k)
      continue
    }
    let label = k
    if (info.version) label += ` (${info.version})`
    if (info.path) label += ` at ${info.path}`
    avail.push(label)
  }
  let out = ""
  if (avail.length) out += `Available tools: ${avail.join(", ")}\n`
  if (missing.length) out += `Unavailable tools: ${missing.join(", ")}\n`
  return out.trim() || "No tools checked"
}

export async function gatherToolAvailability(requested?: string[]) {
  const defaults = getDefaultTools()
  const all = Array.from(new Set([...(requested || []), ...defaults]))
  const map = await checkToolAvailability(all)
  const formattedAll = formatToolAvailability(map)
  const formattedSubset = requested && requested.length ? formatToolAvailability(map, requested) : undefined
  return { map, formattedAll, formattedSubset }
}
