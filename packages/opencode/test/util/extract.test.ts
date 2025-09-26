import { describe, expect, test } from "bun:test"
import { extractCodeFromMarkdown, parseReportAndCodeSections } from "../../src/util/extract"

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

interface SectionCase {
  name: string
  input: string
  expected: { report: string; codePart: string }
}

const sectionCases: SectionCase[] = [
  {
    name: "xml tags with code fence",
    input: [
      "<report>",
      "This is a report.",
      "</report>",
      "<code>",
      "```js\nconsole.log('hi')\n```",
      "</code>"
    ].join("\n"),
    expected: {
      report: "This is a report.",
      codePart: "console.log('hi')"
    }
  },
  {
    name: "xml tags with raw code",
    input: [
      "<report>",
      "Report only.",
      "</report>",
      "<code>",
      "raw code line",
      "</code>"
    ].join("\n"),
    expected: {
      report: "Report only.",
      codePart: "raw code line"
    }
  },
  {
    name: "markdown headers with code fence",
    input: [
      "## Report",
      "Header report.",
      "## Code",
      "```ts\nconst x = 2\n```"
    ].join("\n"),
    expected: {
      report: "Header report.",
      codePart: "const x = 2"
    }
  },
  {
    name: "markdown headers with raw code",
    input: [
      "## Report",
      "Header report.",
      "## Code",
      "plain code"
    ].join("\n"),
    expected: {
      report: "Header report.",
      codePart: "plain code"
    }
  },
  {
    name: "only code header, no report",
    input: [
      "Some intro text",
      "## Code",
      "```py\nprint('hello')\n```"
    ].join("\n"),
    expected: {
      report: "",
      codePart: "print('hello')"
    }
  },
  {
    name: "no tags or headers, returns trimmed",
    input: "  just code here  ",
    expected: {
      report: "",
      codePart: "just code here"
    }
  },
  {
    name: "empty string",
    input: "",
    expected: {
      report: "",
      codePart: ""
    }
  }
]

describe("parseReportAndCodeSections", () => {
  test.each(sectionCases)("%s", (c) => {
    const out = parseReportAndCodeSections(c.input)
    expect(out).toEqual(c.expected)
  })
})
