import z from "zod/v4"
import { Tool } from "./tool"
import DESCRIPTION from "./diff.txt"
import { $ } from "bun"
import { Instance } from "../project/instance"

export const DiffTool = Tool.define("diff", {
  description: DESCRIPTION,
  parameters: z.object({
    combined: z.boolean().optional().describe("Show combined unstaged + staged diffs"),
    commit: z.string().optional().describe("Show diff for specific commit hash (overrides selection logic)"),
    path: z.string().optional().describe("Limit diff to path (file or directory)"),
    context: z
      .number()
      .int()
      .optional()
      .describe("Number of context lines (passes -U to git)")
      .refine((n) => n === undefined || n >= 0),
    nameOnly: z.boolean().optional().describe("Show only changed file names (git diff --name-only)"),
  }),
  key: (p) => {
    const mode = p.commit ? "commit" : p.combined ? "combined" : "working"
    const name = p.nameOnly ? 1 : 0
    return ["diff", mode, name, p.commit || "-"].join("|")
  },
  enableRefresh: (p) => !p.commit,
  async execute(params, _ctx) {
    // Ensure project uses git and git binary is available
    const project = Instance.project
    if (project.vcs !== "git") {
      return {
        title: "diff",
        output: "Version control is not git; diff tool unavailable",
        metadata: { mode: "disabled", staged: false, unstaged: false, commit: null },
      }
    }
    // quick git availability check (cache not necessary here due to light cost)
    const gitVersion = await $`git --version`.quiet().nothrow().text()
    if (!gitVersion.trim()) {
      return {
        title: "diff",
        output: "git executable not found in PATH",
        metadata: { mode: "disabled", staged: false, unstaged: false, commit: null },
      }
    }

    // If commit specified and not combined mode, show that commit diff
    const cwd = Instance.directory

    async function run(literals: TemplateStringsArray, ...values: any[]) {
      // Reconstruct command string with interpolated values safely quoted by bun's template handling
      const result = await $(literals, ...values)
        .cwd(cwd)
        .quiet()
        .nothrow()
        .text()
      return result
    }

    const baseArgs: string[] = []
    if (params.context !== undefined) baseArgs.push(`-U${params.context}`)
    if (params.nameOnly) baseArgs.push("--name-only")

    const pathFilter = params.path ? [params.path] : []

    // Helper to check if there are staged/unstaged changes
    const unstagedCheck = await run`git diff --name-only ${pathFilter}`
    const hasUnstaged = !!unstagedCheck.trim()
    const stagedCheck = await run`git diff --staged --name-only ${pathFilter}`
    const hasStaged = !!stagedCheck.trim()

    let title = ""
    let output = ""

    if (params.combined) {
      const unstaged = await run`git diff ${baseArgs} ${pathFilter}`
      const staged = await run`git diff --staged ${baseArgs} ${pathFilter}`
      output = [unstaged.trim(), staged.trim()].filter(Boolean).join("\n\n") || "No changes"
      title = "combined"
      return {
        title,
        output,
        metadata: { mode: "combined", staged: hasStaged, unstaged: hasUnstaged, commit: params.commit ?? null },
      }
    }

    if (params.commit) {
      // show diff of commit
      const commitDiff = await run`git show --format= ${baseArgs} ${params.commit}`
      output = commitDiff.trim() || `No diff for commit ${params.commit}`
      title = params.commit.slice(0, 12)
      return { title, output, metadata: { mode: "commit", commit: params.commit, staged: false, unstaged: false } }
    }

    if (hasUnstaged) {
      const diff = await run`git diff ${baseArgs} ${pathFilter}`
      output = diff.trim() || "No unstaged changes"
      title = "unstaged"
      return { title, output, metadata: { mode: "unstaged", staged: hasStaged, unstaged: hasUnstaged, commit: null } }
    }

    if (hasStaged) {
      const diff = await run`git diff --staged ${baseArgs} ${pathFilter}`
      output = diff.trim() || "No staged changes"
      title = "staged"
      return { title, output, metadata: { mode: "staged", staged: hasStaged, unstaged: hasUnstaged, commit: null } }
    }

    // fallback: last commit diff
    const last = await run`git show --format= ${baseArgs} HEAD ${pathFilter}`
    output = last.trim() || "Repository clean and no commits"
    title = "HEAD"
    return { title, output, metadata: { mode: "head", staged: false, unstaged: false, commit: "HEAD" } }
  },
})
