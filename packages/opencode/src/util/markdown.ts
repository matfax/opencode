// Extract code from markdown code blocks gracefully
export function extractCodeFromMarkdown(text: string): string {
  if (!text) return ""
  // Normalize Windows CRLF to LF first
  const normalized = text.replace(/\r\n/g, "\n").trim()

  // Collect all fenced code blocks (``` / ''' / """), optional language tag, greedy inner capture
  const fenceRegex = /(?:```|'''|""\")(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n(?:```|'''|""\")/g
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = fenceRegex.exec(normalized)) !== null) {
    blocks.push(match[1])
  }

  if (blocks.length === 1) {
    return blocks[0]
  }
  if (blocks.length > 1) {
    // Return longest (ties: first)
    let longest = blocks[0]
    for (let i = 1; i < blocks.length; i++) {
      if (blocks[i].length > longest.length) longest = blocks[i]
    }
    return longest
  }

  // Full-document single fence without trailing newline before closing (edge case)
  if (/^(?:```|'''|""\")(?:[a-zA-Z0-9_-]+)?\s*\n[\s\S]*?(?:```|'''|""\")$/.test(normalized)) {
    const lines = normalized.split("\n")
    lines.shift()
    lines.pop()
    return lines.join("\n")
  }

  return normalized
}

// Generic parser to extract a leading report (## Report) and a code section (## Code)
// Falls back gracefully if headings are absent. Returns raw report (no markdown fence stripping)
// and codePart with code fences removed via extractCodeFromMarkdown.
export function parseReportAndCodeSections(raw: string): { report: string; codePart: string } {
  if (!raw) return { report: "", codePart: "" }
  const lower = raw.toLowerCase()
  const reportIdx = lower.indexOf("## report")
  const codeIdx = lower.indexOf("## code")
  let report = ""
  let codePart = raw
  if (reportIdx !== -1 && codeIdx !== -1 && codeIdx > reportIdx) {
    report = raw.slice(reportIdx + "## report".length, codeIdx).trim()
    codePart = raw.slice(codeIdx + "## code".length).trim()
  } else if (codeIdx !== -1) {
    codePart = raw.slice(codeIdx + "## code".length).trim()
  }
  codePart = extractCodeFromMarkdown(codePart)
  return { report, codePart }
}
