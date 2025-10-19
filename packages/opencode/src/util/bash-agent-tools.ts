import { success } from "../tool/metadata"
import z from "zod/v4"
import { Tool } from "../tool/tool"
import { gatherToolAvailability } from "./tool-availability"
import { exec } from "child_process"
import { Instance } from "../project/instance"
import { Filesystem } from "./filesystem"

// Import existing tools
import { ListTool } from "../tool/ls"
import { ReadTool } from "../tool/read"
import { GrepTool } from "../tool/grep"
import { GlobTool } from "../tool/glob"

// Import unified permission system
import { BashPermissions } from "./bash-permissions"

const DEFAULT_READ_LIMIT = 1000

// Tool availability checker for bash-summary agent
export const checkCommandAvailability = Tool.define("command-availability", {
  description: "Check availability of shell commands and tools",
  parameters: z.object({
    tools: z.array(z.string()).describe("Array of command names or patterns to check availability for"),
  }),
  async execute(params) {
    const toolData = await gatherToolAvailability(params.tools)

    return {
      title: `Command availability check for ${params.tools.length} tools`,
      metadata: {
        availableTools: toolData.formattedAll,
        requestedTools: params.tools,
      },
      output: success(toolData.formattedAll || "No tools checked"),
    }
  },
})

// Help command executor for bash-summary agent
export const executeHelp = Tool.define("help", {
  description: "Execute help commands to get command documentation",
  parameters: z.object({
    helpCommand: z.string().describe("The exact help command to execute"),
  }),
  async execute(params, ctx) {
    const process = exec(params.helpCommand, {
      cwd: Instance.directory,
      signal: ctx.abort,
      timeout: 10000, // 10 second timeout for help commands
    })

    let output = ""

    process.stdout?.on("data", (chunk) => {
      output += chunk.toString()
    })

    process.stderr?.on("data", (chunk) => {
      output += chunk.toString()
    })

    await new Promise<void>((resolve) => {
      process.on("close", () => {
        resolve()
      })
    })

    // Limit help output to reasonable size
    const limitedOutput = output.length > 4000 ? output.slice(0, 4000) + "\n\n(Help output truncated)" : output

    return {
      title: `Help: ${params.helpCommand}`,
      metadata: {
        helpCommand: params.helpCommand,
        exitCode: process.exitCode || 0,
        originalLength: output.length,
      },
      output: success(limitedOutput),
    }
  },
})

// Simplified tool wrappers for bash agent - strips out AI features like auto-summarize, caching, etc.
export const BashAgentTools = {
  ls: Tool.define("list", {
    description: "List files and directories",
    parameters: z.object({
      path: z.string().optional().describe("Directory path to list"),
      ignore: z.array(z.string()).optional().describe("Patterns to ignore"),
    }),
    async execute(params: any, ctx: any) {
      const result = await ListTool.init().then((tool: any) => tool.execute(params, ctx))
      return result
    },
  }),

  read: Tool.define("read", {
    description: "Read file contents",
    parameters: z.object({
      filePath: z.string().describe("Path to file to read"),
      offset: z.number().optional().describe("Line number to start from").default(0),
      limit: z.number().optional().describe("Number of lines to read").default(DEFAULT_READ_LIMIT),
    }),
    async execute(params: any, ctx: any) {
      // Strip AI features from read tool and parse params through ReadTool's schema to apply defaults
      const readTool = await ReadTool.init()
      const parsedParams = readTool.parameters.parse({
        ...params,
        autoSummarize: false, // Disable auto-summarization
        prompt: undefined, // No summary prompts
      })
      const result = await readTool.execute(parsedParams, ctx)
      return result
    },
  }),

  grep: Tool.define("grep", {
    description: "Search for patterns in files",
    parameters: z.object({
      pattern: z.string().describe("Regex pattern to search for"),
      path: z.string().optional().describe("Directory to search in"),
      include: z.string().optional().describe("File pattern to include"),
    }),
    async execute(params: any, ctx: any) {
      const result = await GrepTool.init().then((tool: any) => tool.execute(params, ctx))
      return result
    },
  }),

  glob: Tool.define("glob", {
    description: "Find files matching glob patterns",
    parameters: z.object({
      pattern: z.string().describe("Glob pattern to match"),
      path: z.string().optional().describe("Directory to search in"),
    }),
    async execute(params: any, ctx: any) {
      const result = await GlobTool.init().then((tool: any) => tool.execute(params, ctx))
      return result
    },
  }),

  execute: Tool.define("execute", {
    description: "Execute a single shell command and return the output",
    parameters: z.object({
      command: z.string().describe("The shell command to execute"),
      directory: z.string().optional().describe("Optional directory to run command in"),
      timeout: z.number().optional().describe("Optional timeout in seconds").default(120),
    }),
    async execute(params: any, ctx: any) {
      const workingDir = params.directory || Instance.directory

      // Basic path validation
      if (params.directory && !Filesystem.contains(Instance.directory, params.directory)) {
        throw new Error(`Directory ${params.directory} is outside the project directory`)
      }

      // **CRITICAL**: Apply full permission checks for bash agent execute tool
      await BashPermissions.checkCommand(params.command, ctx, {
        description: "Bash agent execute",
        agentName: "bash",
        toolContext: "bash-agent-execute",
      })

      const process = exec(params.command, {
        cwd: workingDir,
        signal: ctx.abort,
        timeout: params.timeout * 1000, // Convert to milliseconds
      })

      let output = ""

      process.stdout?.on("data", (chunk) => {
        output += chunk.toString()
      })

      process.stderr?.on("data", (chunk) => {
        output += chunk.toString()
      })

      await new Promise<void>((resolve) => {
        process.on("close", () => {
          resolve()
        })
      })

      return {
        title: params.command,
        metadata: {
          command: params.command,
          directory: workingDir,
          exitCode: process.exitCode || 0,
        },
        output: success(output || "(No output)"),
      }
    },
  }),
}

// Function to create tool context for bash agent
export function createBashAgentContext(originalCtx: any, toolName: string): any {
  return {
    ...originalCtx,
    metadata: (input: any) => {
      // Forward metadata but prefix with tool name for clarity
      originalCtx.metadata({
        ...input,
        metadata: {
          ...input.metadata,
          bashAgentTool: toolName,
        },
      })
    },
  }
}
