/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  // Handle empty strings
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

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
