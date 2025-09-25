import { describe, expect, test } from "bun:test"
import path from "path"
import { BashTool } from "../../src/tool/bash"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"

const ctx = {
  sessionID: "test",
  messageID: "",
  toolCallID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

const bash = await BashTool.init()
const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("tool.bash", () => {
  test("basic", async () => {
    await Instance.provide(projectRoot, async () => {
      const result = await bash.execute(
        {
          command: "echo 'test'",
          description: "Echo test message",
          limit: 1000,
          maxIterations: 1,
          maxConsecutiveFailures: 1,
        },
        ctx,
      )
      const md: any = result.metadata
      expect(md.exit).toBe(0)
      expect(md.output).toContain("test")
    })
  })

  test("cd ../ should fail outside of project root", async () => {
    await Instance.provide(projectRoot, async () => {
      expect(
        bash.execute(
          {
            command: "cd ../",
            description: "Try to cd to parent directory",
              limit: 1000,
              maxIterations: 1,
              maxConsecutiveFailures: 1,
          },
          ctx,
        ),
      ).rejects.toThrow("This command references paths outside of")
    })
  })
})
