import z from "zod/v4"
import { exec } from "child_process"

import { Tool } from "./tool"
import DESCRIPTION from "./bash.txt"
// @ts-ignore
import BASH_CONSTRUCT_TEMPLATE from "./support/bash.txt"
import BASH_OUTPUT_SUMMARY_TEMPLATE from "./support/bash-output-summary.txt"
import { Instance } from "../project/instance"
import { generateText } from "ai"
import { BashPermissions } from "../util/bash-permissions"
import { buildSupportModelParams } from "../session/support-model-params"

const DEFAULT_LIMIT = 1_000
const DEFAULT_TIMEOUT = 1 * 60 * 1000
const MAX_TIMEOUT = 10 * 60 * 1000
const DEFAULT_EXPIRATION = 5
const DEFAULT_MAX_ITERATIONS = 10
const DEFAULT_CONSECUTIVE_FAILURES = 2

async function executeCommand(command: string, timeout: number, ctx: any, directory?: string) {
  const dir = directory ? directory : Instance.directory
  const proc = exec(command, { cwd: dir, signal: ctx.abort, timeout })
  let out = ""
  proc.stdout?.on("data", (c) => {
    out += c.toString()
  })
  proc.stderr?.on("data", (c) => {
    out += c.toString()
  })
  await new Promise<void>((resolve) => {
    proc.on("close", () => resolve())
  })
  return { output: out, exitCode: proc.exitCode || 0 }
}

async function handleAgenticMode(params: any, ctx: any) {
  const maxIter = params.maxIterations || DEFAULT_MAX_ITERATIONS
  const maxFail = params.maxConsecutiveFailures || DEFAULT_CONSECUTIVE_FAILURES
  let i = 0
  let fails = 0
  const convo: Array<{ role: "user" | "assistant"; content: string }> = []

  convo.push({ role: "user", content: params.description })

  type Step = { index: number; assistant: string; command: string; exitCode: number; output: string }
  const steps: Step[] = []

  while (i < maxIter) {
    const { params: supportParams, prompt } = await buildSupportModelParams("bash", ctx.agent, ctx.sessionID)
    const systemPrompt = prompt ?? BASH_CONSTRUCT_TEMPLATE
    const gen = await generateText({
      ...supportParams,
      maxRetries: 3,
      messages: [
        { role: "system", content: systemPrompt },
        ...convo
      ]
    })
    const assistant = gen.text.trim()
    const done = assistant.toLowerCase().includes("done") || assistant.toLowerCase().includes("complete")
    if (done) break

    const cmd = assistant
    await BashPermissions.checkCommand(cmd, ctx, { description: `Agentic iteration ${i + 1}` })
    const res = await executeCommand(cmd, params.timeout || DEFAULT_TIMEOUT, ctx)

    steps.push({ index: i + 1, assistant, command: cmd, exitCode: res.exitCode, output: res.output })

    convo.push({ role: "assistant", content: cmd })
    convo.push({ role: "user", content: `Exit code: ${res.exitCode}\nOutput: ${res.output}` })

    if (res.exitCode !== 0) {
      fails += 1
      if (fails >= maxFail) break
    } else {
      fails = 0
    }

    i += 1
    ctx.metadata({
      metadata: {
        currentIteration: i,
        totalIterations: maxIter,
        lastCommand: cmd,
        lastOutput: res.output,
        lastExitCode: res.exitCode,
      },
    })
  }

  const extended = steps
    .map(
      (s) =>
        `## Step ${s.index}\nAssistant:\n${s.assistant}\n\nExecute:\n${s.command}\n\nExit code: ${s.exitCode}\nOutput:\n${s.output}\n`,
    )
    .join("\n---\n\n")

  const limit = params.limit ?? DEFAULT_LIMIT
  let out = extended
  let summarized = false

  if (extended.length > limit) {
    if (params.autosummarize) {
      const instr = params.description
        ? `Summarize the following multi-step agentic bash session. Include the intent, key commands, notable outputs, and overall status.\n\nIntent: ${params.description}\n\nTranscript:\n'''${extended}'''`
        : `Summarize the following multi-step agentic bash session. Include key commands, notable outputs, and overall status.\n\nTranscript:\n'''${extended}'''`

      const { params: supportParams, prompt } = await buildSupportModelParams("bash-summary", ctx.agent, ctx.sessionID)
      const systemPrompt = prompt ?? BASH_OUTPUT_SUMMARY_TEMPLATE
      const sum = await generateText({
        ...supportParams,
        maxRetries: 3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: instr },
        ],
      })
      out = sum.text
      summarized = true
    } else {
      out = extended.slice(0, limit) + "\n\n(Output was truncated due to length limit)"
    }
  }

  return {
    title: `Agentic execution (${steps.length} commands)`,
    metadata: {
      agenticMode: true,
      totalCommands: steps.length,
      summarized,
      originalLength: extended.length,
      results: steps.map((s) => ({
        command: s.command,
        output: s.output,
        exitCode: s.exitCode,
        description: `Step ${s.index}`,
        assistant: s.assistant,
        toolCall: { name: "execute", directory: Instance.directory },
      })),
    },
    output: out,
  }
}

export const BashTool = Tool.define("bash", {
  description: DESCRIPTION,
  parameters: z.object({
    command: z
      .string()
      .optional()
      .describe("The direct command to execute. If provided, description is used as context/explanation only."),
    description: z
      .string()
      .describe(
        "Description of what you want to accomplish. Used as natural language instructions when no command is provided, or as context when command is provided.",
      ),
    timeout: z.number().optional().describe("Optional timeout in milliseconds"),
    limit: z
      .number()
      .optional()
      .default(DEFAULT_LIMIT)
      .describe(
        "If > 0, the output of the invoked command will either be truncated or summarized to fit within this character limit (default `" +
          DEFAULT_LIMIT +
          "` characters)",
      ),
    autosummarize: z
      .boolean()
      .optional()
      .describe(
        "Attempt to summarize the output to fit within the limit instead of truncating it, if limit is exceeded",
      ),
    maxIterations: z
      .number()
      .optional()
      .default(DEFAULT_MAX_ITERATIONS)
      .describe("Maximum number of command iterations in agentic mode"),
    maxConsecutiveFailures: z
      .number()
      .optional()
      .default(DEFAULT_CONSECUTIVE_FAILURES)
      .describe("In agentic mode, maximum number of consecutive command failures before stopping execution"),
  }),
  key: (p) => ["bash", !p.command ? "agentic" : "direct", p.command ? p.command : p.description].join("|"),
  expireAfter: (p) => (!!p.command && p.autosummarize ? undefined : DEFAULT_EXPIRATION),
  async execute(params, ctx) {
    const timeout = Math.min(params.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
    if (!params.command) return handleAgenticMode(params, ctx)

    const cmd = params.command
    const desc = params.description

    await BashPermissions.checkCommand(cmd, ctx, { description: desc })

    const proc = exec(cmd, { cwd: Instance.directory, signal: ctx.abort, timeout })
    let out = ""

    ctx.metadata({ metadata: { output: "", description: desc } })

    proc.stdout?.on("data", (chunk) => {
      out += chunk.toString()
      ctx.metadata({ metadata: { output: out, description: desc } })
    })
    proc.stderr?.on("data", (chunk) => {
      out += chunk.toString()
      ctx.metadata({ metadata: { output: out, description: desc } })
    })

    await new Promise<void>((resolve) => {
      proc.on("close", () => resolve())
    })

    ctx.metadata({ metadata: { output: out, exit: proc.exitCode, description: desc } })

    let finalOut = out
    let summarized = false
    const limit = params.limit ?? DEFAULT_LIMIT
    if (out.length > limit) {
      if (params.autosummarize) {
        const instr = params.description
          ? `Please summarize the following command output that had the original intent: ${params.description}\n\nCommand: ${cmd}\nOutput:\n'''${out}'''`
          : `Please summarize the following command output:\n\nCommand: ${cmd}\nOutput:\n'''${out}'''`

        const { params: supportParams, prompt } = await buildSupportModelParams("bash-summary", ctx.agent, ctx.sessionID)
        const systemPrompt = prompt ?? BASH_OUTPUT_SUMMARY_TEMPLATE
        const sum = await generateText({
          ...supportParams,
          maxRetries: 3,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: instr },
          ],
        })
        finalOut = sum.text
        summarized = true
      } else {
        finalOut = out.slice(0, limit) + "\n\n(Output was truncated due to length limit)"
      }
    }

    return {
      title: cmd,
      metadata: {
        output: finalOut,
        exit: proc.exitCode,
        description: desc,
        summarized,
        originalLength: out.length,
        agenticMode: false,
        totalCommands: 1,
        results: [
          {
            command: cmd,
            output: finalOut,
            exitCode: proc.exitCode || 0,
            description: desc,
            assistant: "",
            toolCall: { name: "execute", directory: Instance.directory },
          },
        ],
      },
      output: finalOut,
    }
  },
})
