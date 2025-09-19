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
    const lines = normalized.split('\n')
    lines.shift()
    lines.pop()
    return lines.join('\n')
  }

  return normalized
}
