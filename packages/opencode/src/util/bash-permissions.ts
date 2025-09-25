import { Agent } from "../agent/agent"
import { Permission } from "../permission"
import { Wildcard } from "../util/wildcard"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { lazy } from "../util/lazy"
import { Log } from "../util/log"
import { $ } from "bun"

const log = Log.create({ service: "bash-permissions" })

const parser = lazy(async () => {
  try {
    const { default: Parser } = await import("tree-sitter")
    const Bash = await import("tree-sitter-bash")
    const p = new Parser()
    p.setLanguage(Bash.language as any)
    return p
  } catch (e) {
    const { default: Parser } = await import("web-tree-sitter")
    const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } })
    await Parser.init({
      locateFile() {
        return treeWasm
      },
    })
    const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
      with: { type: "wasm" },
    })
    const bashLanguage = await Parser.Language.load(bashWasm)
    const p = new Parser()
    p.setLanguage(bashLanguage)
    return p
  }
})

export namespace BashPermissions {
  /**
   * Comprehensive permission check for bash commands
   * Handles path validation, permission patterns, and user prompts
   */
  export async function checkCommand(
    command: string,
    ctx: any,
    options: {
      description?: string
      agentName?: string
      toolContext?: string
    } = {},
  ) {
    const { description, agentName = ctx.agent, toolContext } = options

    const tree = await parser().then((p) => p.parse(command))
    const permissions = await Agent.get(agentName).then((x) => x.permission.bash)

    const askPatterns = new Set<string>()

    for (const node of tree.rootNode.descendantsOfType("command")) {
      const cmdParts = []
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (!child) continue
        if (
          child.type !== "command_name" &&
          child.type !== "word" &&
          child.type !== "string" &&
          child.type !== "raw_string" &&
          child.type !== "concatenation"
        ) {
          continue
        }
        cmdParts.push(child.text)
      }

      // Path validation for dangerous commands
      if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown"].includes(cmdParts[0])) {
        for (const arg of cmdParts.slice(1)) {
          if (arg.startsWith("-") || (cmdParts[0] === "chmod" && arg.startsWith("+"))) continue
          const resolved = await $`realpath ${arg}`
            .quiet()
            .nothrow()
            .text()
            .then((x) => x.trim())
          log.info("resolved path", { arg, resolved, command })
          if (resolved && !Filesystem.contains(Instance.directory, resolved)) {
            throw new Error(
              `This command references paths outside of ${Instance.directory} so it is not allowed to be executed.`,
            )
          }
        }
      }

      // Permission checks (skip cd as it's allowed if path check passes)
      if (cmdParts[0] !== "cd") {
        const action = Wildcard.all(node.text, permissions)
        if (action === "deny") {
          throw new Error(
            `The user has specifically restricted access to this command, you are not allowed to execute it. Here is the configuration: ${JSON.stringify(permissions)}`,
          )
        }
        if (action === "ask") {
          const pattern = (() => {
            let head = ""
            let sub: string | undefined
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i)
              if (!child) continue
              if (child.type === "command_name") {
                if (!head) {
                  head = child.text
                }
                continue
              }
              if (!sub && child.type === "word") {
                if (!child.text.startsWith("-")) sub = child.text
              }
            }
            if (!head) return
            return sub ? `${head} ${sub} *` : `${head} *`
          })()
          if (pattern) {
            askPatterns.add(pattern)
          }
        }
      }
    }

    if (askPatterns.size > 0) {
      const patterns = Array.from(askPatterns)
      const title = description ? `${command} - ${description}` : command

      await Permission.ask({
        type: "bash",
        pattern: patterns,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        title,
        metadata: {
          command,
          description,
          patterns,
          agentName,
          toolContext,
        },
      })
    }
  }

  /**
   * Get the tree-sitter parser instance (for advanced use cases)
   */
  export async function getParser() {
    return parser()
  }
}
