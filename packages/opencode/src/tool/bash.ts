import z from "zod/v4"
import { exec } from "child_process"

import { Tool } from "./tool"
import DESCRIPTION from "./bash.txt"
// @ts-ignore
import BASH_CONSTRUCT_TEMPLATE from "./support/bash.txt"
import { Instance } from "../project/instance"
import { streamText, tool, zodSchema, stepCountIs, type Tool as AITool } from "ai"
import { BashPermissions } from "../util/bash-permissions"
import { buildSupportModelParams } from "../session/support-model-params"
import { Template } from "../util/template"

const DEFAULT_LIMIT = 5_000
const DEFAULT_TIMEOUT = 1 * 60 * 1000
const MAX_TIMEOUT = 10 * 60 * 1000
const DEFAULT_EXPIRATION = 10
const DEFAULT_MAX_ITERATIONS = 10
const DEFAULT_CONSECUTIVE_FAILURES = 3

function getBashInputs() {
  // Detect shell: PowerShell on Windows, then fallback to SHELL or ComSpec
  let shell = "unknown"
  if (process.platform === "win32") {
    // Check for PowerShell first (PSModulePath exists in PowerShell)
    if (process.env["PSModulePath"]) {
      shell = "PowerShell"
    } else {
      shell = process.env["ComSpec"] || "cmd.exe"
    }
  } else {
    shell = process.env["SHELL"] || "sh"
  }

  return {
    os: process.platform,
    shell,
    cwd: Instance.directory,
  }
}

function deduplicateLines(output: string): string {
  const lines = output.split("\n")
  const deduplicated: string[] = []
  let currentLine = ""
  let count = 0

  const flush = () => {
    if (currentLine !== "") {
      deduplicated.push(count > 1 ? `${currentLine} (repeated ${count} times)` : currentLine)
    }
  }

  for (const line of lines) {
    if (line === currentLine) {
      count++
    } else {
      flush()
      currentLine = line
      count = 1
    }
  }

  flush()
  return deduplicated.join("\n")
}

function truncateOutput(output: string, limit: number): string {
  // First deduplicate lines
  const deduplicated = deduplicateLines(output)

  if (deduplicated.length <= limit) return deduplicated

  const truncationMessage = "\n\n... (Output truncated due to length limit) ...\n\n"
  const availableSpace = limit - truncationMessage.length
  const halfSpace = Math.floor(availableSpace / 2)

  const start = deduplicated.slice(0, halfSpace)
  const end = deduplicated.slice(-halfSpace)

  return start + truncationMessage + end
}

async function executeCommand(command: string, timeout: number, ctx: any, limit: number, directory?: string) {
  const dir = directory ? directory : Instance.directory
  const proc = exec(command, { cwd: dir, signal: ctx.abort, timeout })
  let out = ""
  let lastUpdate = Date.now()
  const UPDATE_INTERVAL = 300 // ms

  const reportLiveOutput = () => {
    if (Date.now() - lastUpdate >= UPDATE_INTERVAL) {
      ctx.metadata({
        metadata: {
          status: "Executing",
          commands: {
            [command]: {
              output: out,
            },
          },
        },
      })
      lastUpdate = Date.now()
    }
  }

  proc.stdout?.on("data", (c) => {
    out += c.toString()
    reportLiveOutput()
  })
  proc.stderr?.on("data", (c) => {
    out += c.toString()
    reportLiveOutput()
  })
  await new Promise<void>((resolve) => {
    proc.on("close", () => resolve())
  })
  const exitCode = proc.exitCode || 0
  ctx.metadata({
    metadata: {
      status: exitCode === 0 ? "Completed" : "Failed",
      commands: {
        [command]: {
          output: out,
          exitCode: exitCode,
        },
      },
    },
  })
  const truncated = truncateOutput(out, limit)
  return { output: truncated, exitCode }
}

function createBashExecuteTool(
  ctx: any,
  timeout: number,
  limit: number,
  state: { commandCount: number; maxCommands: number; maxFailuresReached: boolean },
): AITool {
  return tool({
    description: "Execute a CLI command and receive the output with the exit code",
    inputSchema: zodSchema(
      z.object({
        command: z.string().describe("The CLI command to execute"),
        timeout: z.number().optional().default(timeout).describe("Timeout for this command in milliseconds"),
        limit: z.number().optional().default(limit).describe("Character limit that the output will be truncated to"),
      }),
    ),
    async execute({ command, timeout: cmdTimeout, limit: cmdLimit }) {
      // Check limits before executing
      if (state.commandCount >= state.maxCommands) {
        return JSON.stringify({
          exitCode: -1,
          output: `Maximum command limit (${state.maxCommands}) reached. Please provide a summary of what was accomplished.`,
          status: -1,
        })
      }

      if (state.maxFailuresReached) {
        return JSON.stringify({
          exitCode: -1,
          output: "Maximum consecutive failures reached. Please provide a summary of what was attempted.",
          status: -1,
        })
      }

      await BashPermissions.checkCommand(command, ctx, {
        description: "Agentic execution",
      })

      state.commandCount++
      const effectiveTimeout = cmdTimeout ?? timeout
      const effectiveLimit = cmdLimit ?? limit
      const result = await executeCommand(command, effectiveTimeout, ctx, effectiveLimit)

      return JSON.stringify({
        exitCode: result.exitCode,
        output: result.output,
        status: result.exitCode,
      })
    },
  }) as AITool
}

async function handleAgenticMode(params: any, ctx: any) {
  const maxIter = params.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const maxFail = params.maxConsecutiveFailures ?? DEFAULT_CONSECUTIVE_FAILURES
  const timeout = params.timeout ?? DEFAULT_TIMEOUT
  const limit = params.limit ?? DEFAULT_LIMIT

  let fails = 0
  const toolState = {
    commandCount: 0,
    maxCommands: maxIter,
    maxFailuresReached: false,
  }
  const steps: Array<{
    text: string
    exitCode?: number
    type: "command" | "text-delta"
  }> = []

  // Report initial metadata
  ctx.metadata({
    metadata: {
      maxRetries: maxFail,
    },
  })

  // Build system prompt with input substitution
  const { params: supportParams, systemMessages } = await buildSupportModelParams(
    "bash",
    ctx.agent,
    BASH_CONSTRUCT_TEMPLATE,
    ctx.sessionID,
  )

  // Substitute {input:} patterns in the last system message (main prompt, not spoof header)
  const substitutedMessages = await Promise.all(
    systemMessages.map(async (msg, idx) => ({
      role: "system" as const,
      content: idx === systemMessages.length - 1 ? await Template.substituteInputs(msg, getBashInputs()) : msg,
    })),
  )

  // Create execute tool with shared state
  const bashTool = createBashExecuteTool(ctx, timeout, limit, toolState)

  // Stream with tool calling
  const stream = streamText({
    ...supportParams,
    messages: [...substitutedMessages, { role: "user", content: params.goal }],
    tools: { execute_cli: bashTool },
    abortSignal: ctx.abort,
    stopWhen: stepCountIs(Math.max(maxIter + 1, 2)),
  })

  for await (const chunk of stream.fullStream) {
    ctx.abort.throwIfAborted?.()

    switch (chunk.type) {
      case "text-delta":
        // Check if the text contains a retry-after JSON structure (rate limit)
        try {
          const parsed = JSON.parse(chunk.text)
          if (parsed["retry-after"]) {
            throw new Error("Rate limit encountered during agentic bash execution")
          }
        } catch (e) {
          // Not JSON or doesn't contain retry-after, continue normally
          if (e instanceof Error && e.message.includes("Rate limit")) {
            throw e
          }
        }

        steps.push({
          text: chunk.text,
          type: "text-delta",
        })
        ctx.metadata({
          metadata: {
            steps,
            status: "Thinking",
          },
        })
        break

      case "tool-call":
        if (chunk.toolName === "execute_cli") {
          const command = (chunk.input as any).command

          steps.push({
            text: command,
            type: "command",
          })

          ctx.metadata({
            metadata: {
              steps,
              lastCommand: command,
              status: "Executing",
            },
          })
        }
        break

      case "tool-result":
        if (chunk.toolName === "execute_cli") {
          try {
            const parsed = JSON.parse(chunk.output as string)
            const command = (chunk.input as any).command

            // Set status code of last command or push new step
            if (
              steps.length > 0 &&
              steps[steps.length - 1].type === "command" &&
              steps[steps.length - 1].text === command
            ) {
              steps[steps.length - 1].exitCode = parsed.exitCode
            } else {
              steps.push({
                text: command,
                exitCode: parsed.exitCode,
                type: "command",
              })
            }

            ctx.metadata({
              metadata: {
                steps,
                lastCommand: command,
                lastExitCode: parsed.exitCode,
              },
            })

            // Track failures
            if (parsed.exitCode !== 0) {
              fails++
              if (fails >= maxFail) {
                toolState.maxFailuresReached = true
              }
            } else {
              fails = 0
              toolState.maxFailuresReached = false
            }

            // Stream progress
            ctx.metadata({
              metadata: {
                attempt: fails + 1,
              },
            })
          } catch (e) {
            // Ignore parse errors
          }
        }
        break
    }
  }

  // Return with LLM's natural summary (NOT truncated)
  return {
    title: `Agentic execution (${steps.length} commands)`,
    metadata: {
      steps,
    },
    output: steps
      .map((s) => (s.type === "command" ? `$ ${s.text}\n(exit code: ${s.exitCode ?? "pending"})` : s.text))
      .join("\n"),
  }
}

export const BashTool = Tool.define("bash", {
  description: DESCRIPTION,
  parameters: z.object({
    command: z.string().optional().describe("The CLI command to execute (enables direct mode)"),
    goal: z.string().describe("What you want to accomplish (direct mode: context, agentic mode: objective)"),
    timeout: z.number().optional().default(DEFAULT_TIMEOUT).describe("Optional timeout in milliseconds"),
    limit: z.number().optional().default(DEFAULT_LIMIT).describe("Character limit for truncating CLI output"),
    maxIterations: z
      .number()
      .optional()
      .default(DEFAULT_MAX_ITERATIONS)
      .describe("Maximum iterations for agentic mode"),
    maxConsecutiveFailures: z
      .number()
      .optional()
      .default(DEFAULT_CONSECUTIVE_FAILURES)
      .describe("Maximum consecutive failures for agentic mode"),
  }),
  key: (p) => ["bash", p.command ? "direct" : "agentic", p.command || p.goal].join("|"),
  expireAfter: (_p) => DEFAULT_EXPIRATION,
  async execute(params, ctx) {
    const timeout = Math.min(params.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
    const limit = params.limit ?? DEFAULT_LIMIT

    // Direct command mode
    if (!!params.command) {
      await BashPermissions.checkCommand(params.command, ctx, { description: params.goal })
      const res = await executeCommand(params.command, timeout, ctx, limit)
      return {
        title: params.command,
        metadata: {
          steps: [
            {
              text: params.command,
              exitCode: res.exitCode,
              type: "command" as const,
            },
          ],
          status: res.exitCode === 0 ? "Completed" : "Failed",
        },
        output: res.output + `\n\n(exit code: ${res.exitCode})`,
      }
    }

    // Agentic mode
    return handleAgenticMode(params, ctx)
  },
})
