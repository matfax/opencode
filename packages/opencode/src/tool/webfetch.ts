import z from "zod/v4"
import { Tool } from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
// @ts-ignore
import SUMMARY_TEMPLATE from "./support/web-summary.txt"
import { Config } from "../config/config"
import { Permission } from "../permission"
import { generateText } from "ai"
import { buildSupportModelParams } from "../session/support-model-params"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30
const MAX_TIMEOUT = 120
const DEFAULT_EXPIRATION = 10 // messages

export const WebFetchTool = Tool.define("webfetch", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().describe("The fully-formed URL to fetch content from"),
    format: z
      .enum(["text", "markdown", "html", "summary"])
      .describe("The format to return the content in (text, markdown, html, or summary)"),
    timeout: z.number().describe("Optional timeout in seconds").optional().default(DEFAULT_TIMEOUT),
    autorefresh: z.boolean().optional().describe("Automatically refresh the fetched website on subsequent prompts"),
    prompt: z
      .string()
      .optional()
      .describe("Optional instruction for what to focus on in the summary (only used with summary format)"),
  }),
  key: (p) => ["webfetch", "f" + p.format, p.url].join("|"),
  enableRefresh: (p) => !!p.autorefresh && p.format !== "summary",
  expireAfter: (p) => (p.autorefresh ? undefined : DEFAULT_EXPIRATION),
  async execute(params, ctx) {
    // Validate URL
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    const cfg = await Config.get()
    if (cfg.permission?.webfetch === "ask")
      await Permission.ask({
        type: "webfetch",
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        title: "Fetch content from: " + params.url,
        metadata: {
          url: params.url,
          format: params.format,
          timeout: params.timeout,
        },
      })

    const timeoutSeconds = Math.min(params.timeout, MAX_TIMEOUT)
    const timeout = timeoutSeconds * 1000

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const response = await fetch(params.url, {
      signal: AbortSignal.any([controller.signal, ctx.abort]),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`Request failed with status code: ${response.status}`)
    }

    // Check content length
    const contentLength = response.headers.get("content-length")
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)")
    }

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)")
    }

    const content = new TextDecoder().decode(arrayBuffer)
    const contentType = response.headers.get("content-type") || ""

    const title = `${params.url} (${contentType})`
    switch (params.format) {
      case "text":
        if (contentType.includes("text/html")) {
          const text = await extractTextFromHTML(content)
          return {
            output: text,
            title,
            metadata: {},
          }
        }
        return {
          output: content,
          title,
          metadata: {},
        }

      case "markdown":
        if (contentType.includes("text/html")) {
          const markdown = convertHTMLToMarkdown(content)
          return {
            output: markdown,
            title,
            metadata: {},
          }
        }
        return {
          output: "```\n" + content + "\n```",
          title,
          metadata: {},
        }

      case "html":
        return {
          output: content,
          title,
          metadata: {},
        }

      case "summary":
        // First convert to markdown
        let markdown = ""
        if (contentType.includes("text/html")) {
          markdown = convertHTMLToMarkdown(content)
        } else {
          markdown = content
        }

        // Generate summary using the support model
        const userInstruction = params.prompt
          ? `Please summarize the following web page content with focus on: ${params.prompt}\n\n'''${markdown}'''`
          : `Please summarize the following web page content:\n\n'''${markdown}'''`

        const { params: supportParams, prompt } = await buildSupportModelParams("summary", ctx.agent, ctx.sessionID)
        const systemPrompt = prompt ?? SUMMARY_TEMPLATE
        const summaryGen = await generateText({
          ...supportParams,
          maxRetries: 3,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userInstruction },
          ],
        })

        return {
          output: summaryGen.text,
          title: `Summary: ${params.url}`,
          metadata: {},
        }

      default:
        return {
          output: content,
          title,
          metadata: {},
        }
    }
  },
})

async function extractTextFromHTML(html: string) {
  let text = ""
  let skipContent = false

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true
      },
      text() {
        // Skip text content inside these elements
      },
    })
    .on("*", {
      element(element) {
        // Reset skip flag when entering other elements
        if (!["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)) {
          skipContent = false
        }
      },
      text(input) {
        if (!skipContent) {
          text += input.text
        }
      },
    })
    .transform(new Response(html))

  await rewriter.text()
  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
