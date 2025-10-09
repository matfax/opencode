import z from "zod/v4"
import { BashTool } from "./bash"
import { checkCommandAvailability, executeHelp, BashAgentTools } from "../util/bash-agent-tools"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ListTool } from "./ls"
import { PatchTool } from "./patch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SymbolTool } from "./symbol"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { MultiEditTool } from "./multiedit"
import { RemoveTool } from "./remove"
import { RenameTool } from "./rename"
import { DiffTool } from "./diff"

export namespace ToolRegistry {
  // Tools for primary, subagent, and general mode agents
  const STANDARD_TOOLS = [
    InvalidTool,
    BashTool,
    EditTool,
    MultiEditTool,
    RemoveTool,
    RenameTool,
    WebFetchTool,
    GlobTool,
    GrepTool,
    ListTool,
    PatchTool,
    ReadTool,
    WriteTool,
    TodoWriteTool,
    TodoReadTool,
    TaskTool,
    SymbolTool,
    DiffTool,
  ]

  // Tools specifically for support mode agents (like bash agent)
  const SUPPORT_AGENT_TOOLS = [
    InvalidTool, // Common tools available to all agents
    checkCommandAvailability,
    executeHelp,
    BashAgentTools.ls,
    BashAgentTools.read,
    BashAgentTools.grep,
    BashAgentTools.glob,
    BashAgentTools.execute,
  ]

  // Extra tools registered at runtime (via plugins)
  const EXTRA: Tool.Info[] = []

  // Tools registered via HTTP callback (via SDK/API)
  const HTTP: Tool.Info[] = []

  export type HttpParamSpec = {
    type: "string" | "number" | "boolean" | "array"
    description?: string
    optional?: boolean
    items?: "string" | "number" | "boolean"
  }
  export type HttpToolRegistration = {
    id: string
    description: string
    parameters: {
      type: "object"
      properties: Record<string, HttpParamSpec>
    }
    callbackUrl: string
    headers?: Record<string, string>
  }

  function buildZodFromHttpSpec(spec: HttpToolRegistration["parameters"]) {
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const [key, val] of Object.entries(spec.properties)) {
      let base: z.ZodTypeAny
      switch (val.type) {
        case "string":
          base = z.string()
          break
        case "number":
          base = z.number()
          break
        case "boolean":
          base = z.boolean()
          break
        case "array":
          if (!val.items) throw new Error(`array spec for ${key} requires 'items'`)
          base = z.array(val.items === "string" ? z.string() : val.items === "number" ? z.number() : z.boolean())
          break
        default:
          base = z.any()
      }
      if (val.description) base = base.describe(val.description)
      shape[key] = val.optional ? base.optional() : base
    }
    return z.object(shape)
  }

  export function register(tool: Tool.Info) {
    // Prevent duplicates by id (replace existing)
    const idx = EXTRA.findIndex((t) => t.id === tool.id)
    if (idx >= 0) EXTRA.splice(idx, 1, tool)
    else EXTRA.push(tool)
  }

  export function registerHTTP(input: HttpToolRegistration) {
    const parameters = buildZodFromHttpSpec(input.parameters)
    const info = Tool.define(input.id, {
      description: input.description,
      parameters,
      async execute(args) {
        const res = await fetch(input.callbackUrl, {
          method: "POST",
          headers: { "content-type": "application/json", ...(input.headers ?? {}) },
          body: JSON.stringify({ args }),
        })
        if (!res.ok) {
          throw new Error(`HTTP tool callback failed: ${res.status} ${await res.text()}`)
        }
        const json = (await res.json()) as { title?: string; output: string; metadata?: Record<string, any> }
        return {
          title: json.title ?? input.id,
          output: json.output ?? "",
          metadata: (json.metadata ?? {}) as any,
        }
      },
    })
    const idx = HTTP.findIndex((t) => t.id === info.id)
    if (idx >= 0) HTTP.splice(idx, 1, info)
    else HTTP.push(info)
  }

  function allTools(agent?: Agent.Info): Tool.Info[] {
    const baseTools = agent?.mode === "support" ? SUPPORT_AGENT_TOOLS : STANDARD_TOOLS
    return [...baseTools, ...EXTRA, ...HTTP]
  }

  export function ids(agent?: Agent.Info) {
    return allTools(agent).map((t) => t.id)
  }

  export async function tools(_providerID: string, _modelID: string, agent?: Agent.Info) {
    const result = await Promise.all(
      allTools(agent).map(async (t) => ({
        id: t.id,
        ...(await t.init()),
      })),
    )
    return result
  }

  export async function enabled(
    _providerID: string,
    _modelID: string,
    agent: Agent.Info,
  ): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {}
    result["patch"] = false
    // Disable diff tool if project is not git
    try {
      const { Instance } = await import("../project/instance")
      if (Instance.project.vcs !== "git") {
        result["diff"] = false
      }
    } catch {}

    if (agent.permission.edit === "deny") {
      result["edit"] = false
      result["patch"] = false
      result["write"] = false
      result["multiedit"] = false
      result["remove"] = false
      result["rename"] = false
    }
    if (agent.permission.bash["*"] === "deny" && Object.keys(agent.permission.bash).length === 1) {
      result["bash"] = false
    }
    if (agent.permission.webfetch === "deny") {
      result["webfetch"] = false
    }

    return result
  }
}
