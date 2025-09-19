import { describe, expect, test } from "bun:test"
import { extractCodeFromMarkdown } from "../../src/util/markdown"

interface Case {
  name: string
  input: string
  expected: string
}

const cases: Case[] = [
  {
    name: "triple backticks with language",
    input: "```ts\nconst a = 1\n```",
    expected: "const a = 1",
  },
  {
    name: "triple backticks no language",
    input: "```\nline1\nline2\n```",
    expected: "line1\nline2",
  },
  {
    name: "triple single quotes with language",
    input: "'''python\nprint('hi')\n'''",
    expected: "print('hi')",
  },
  {
    name: "triple double quotes with language",
    input: '"""go\npackage main\n"""',
    expected: "package main",
  },
  {
    name: "multiple blocks returns longest",
    input: [
      "Some text before",
      "```js\nshort()\n```",
      "More text",
      "```\nlong line 1\nlong line 2\nlong line 3\n```",
    ].join("\n"),
    expected: ["long line 1", "long line 2", "long line 3"].join("\n"),
  },
  {
    name: "inline full fenced block handled",
    input: "```\nonly line\n```",
    expected: "only line",
  },
  {
    name: "fallback no fences returns trimmed",
    input: "  raw content \n",
    expected: "raw content",
  },
]

describe("extractCodeFromMarkdown", () => {
  test.each(cases)("%s", (c) => {
    const out = extractCodeFromMarkdown(c.input)
    expect(out).toBe(c.expected)
  })
})
