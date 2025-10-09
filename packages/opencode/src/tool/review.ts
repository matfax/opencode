import z from "zod/v4"
import { streamText, tool, zodSchema, stepCountIs } from "ai"
import { buildSupportModelParams } from "../session/support-model-params"
import { ReadTool } from "./read"
import { GrepTool } from "./grep"
import { GlobTool } from "./glob"
import { SymbolTool } from "./symbol"
import { Tool } from "./tool"
import { FileDiff } from "../util/file-diff"

// @ts-ignore
import REVIEW_TEMPLATE from "./support/review.txt"

const MAX_REVIEW_STEPS = 15

/**
 * Review agent result
 */
export interface ReviewResult {
  passed: boolean
  summary: string
  suggestions?: string
}

/**
 * Create review agent that validates predicted changes against code requirements
 * This is designed to be called from within the edit tool's agent context
 */
export async function createReviewTool(
  filePath: string,
  lastSuccessfulEditRef: { fileDiff: FileDiff | null; summary: string },
  shadowContent: string,
  shadowContentRef: { newContent: string | null; approved: boolean },
  ctx: Tool.Context<any>,
): Promise<any> {
  return tool({
    description:
      "Review the predicted changes against shadow file requirements. Validates consistency between code changes and shadow updates. Call this after a successful predict and updateRequirements/createRequirements.",
    inputSchema: zodSchema(
      z.object({
        explanation: z.string().describe("Context and motivation for the code and shadow changes"),
      })
    ),
    execute: async ({ explanation }): Promise<ReviewResult> => {
      // Get the predicted FileDiff
      const fileDiff = lastSuccessfulEditRef.fileDiff
      if (!fileDiff) {
        throw new Error("No predicted content to review - call predict first")
      }

      ctx.metadata({
        metadata: {
          status: "Reviewing changes",
        },
      })

      // Create tools for review agent
      const reviewTools = {
        read: tool(await Tool.toAISDKTool(ReadTool, ctx, { omitParams: ["query"] })),
        grep: tool(await Tool.toAISDKTool(GrepTool, ctx)),
        glob: tool(await Tool.toAISDKTool(GlobTool, ctx)),
        symbol: tool(await Tool.toAISDKTool(SymbolTool, ctx, { omitParams: ["autorefresh"], defaultParams: { includeShadow: false } })),
        finalize: tool({
          description: "Finalize the review with validation results (the only way to complete review successfully)",
          inputSchema: zodSchema(
            z.object({
              passed: z.boolean().describe("Whether the review passed (true) or failed (false)"),
              summary: z.string().describe("Explanation of review findings"),
              suggestions: z.string().optional().describe("Natural language suggestions if review failed (what needs to be fixed)"),
            }),
          ),
          execute: async ({ passed, summary, suggestions }): Promise<ReviewResult> => {
            return {
              passed,
              summary,
              suggestions,
            }
          },
        }),
      }

      // Build review prompt using explicit "review" agent
      const { params: reviewParams, systemMessages } = await buildSupportModelParams(
        "review",
        "review", // Explicitly use review agent, not ctx.agent
        REVIEW_TEMPLATE,
        ctx.sessionID,
        filePath,
      )

      // Use annotated content if available (shows full file with inline diff markers)
      // Otherwise fall back to separate diff + new content
      const contentMessage = fileDiff.annotated
        ? {
            role: "user" as const,
            content: `## Predicted File Changes (annotated)\n\nComplete file content with inline diff markers (- = removed, + = added, no marker = unchanged):\n\n\`\`\`\n${fileDiff.annotated}\n\`\`\``,
          }
        : {
            role: "user" as const,
            content: `## Predicted Code Changes\n\`\`\`diff\n${fileDiff.diff}\n\`\`\`\n\n## Predicted New File Content\n\`\`\`\n${fileDiff.newContent}\n\`\`\``,
          }

      // Build messages with code changes, shadow changes, and explanation
      const shadowMessage = shadowContentRef.newContent
        ? {
            role: "user" as const,
            content: `## Predicted Shadow File Changes\n\n### Old Shadow Content\n\`\`\`markdown\n${shadowContent || "(no shadow file exists)"}\n\`\`\`\n\n### New Shadow Content\n\`\`\`markdown\n${shadowContentRef.newContent}\n\`\`\``,
          }
        : shadowContent
          ? {
              role: "user" as const,
              content: `## Current Shadow File\n\`\`\`markdown\n${shadowContent}\n\`\`\`\n\nNo shadow updates were proposed.`,
            }
          : null

      const explanationMessage = {
        role: "user" as const,
        content: `## Context and Motivation\n\n${explanation}`,
      }

      const messages = [
        ...systemMessages.map((msg) => ({ role: "system" as const, content: msg })),
        contentMessage,
        ...(shadowMessage ? [shadowMessage] : []),
        explanationMessage,
      ]

      // Call review model with tools
      let stream
      try {
        stream = streamText({
          ...reviewParams,
          maxRetries: 0,
          messages,
          tools: reviewTools,
          stopWhen: stepCountIs(MAX_REVIEW_STEPS),
        })
      } catch (err: any) {
        // Extract error details from AI SDK error
        const errorMessage = err?.responseBody
          ? `Review model API error: ${JSON.stringify(err.responseBody)}`
          : err?.message || String(err)
        throw new Error(errorMessage)
      }

      // Process stream to get finalize result
      let reviewResult: ReviewResult | undefined

      try {
        for await (const chunk of stream.fullStream) {
          if (chunk.type === "tool-result" && chunk.toolName === "finalize") {
            try {
              const result = typeof chunk.output === "string" ? JSON.parse(chunk.output) : chunk.output
              reviewResult = result
              break
            } catch (err) {
              throw new Error("Review finalize tool returned malformed JSON response")
            }
          }
        }
      } catch (err: any) {
        // Handle streaming errors (might occur during iteration)
        const errorMessage = err?.responseBody
          ? `Review streaming error: ${JSON.stringify(err.responseBody)}`
          : err?.message || String(err)
        throw new Error(errorMessage)
      }

      if (!reviewResult) {
        throw new Error("Review did not complete - finalize tool was not called")
      }

      ctx.metadata({
        metadata: {
          status: reviewResult.passed ? "Review passed" : "Review failed",
        },
      })

      return reviewResult
    },
  })
}
