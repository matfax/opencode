import z from "zod/v4"
import { Tool } from "./tool"
import { success } from "./metadata"

export const InvalidTool = Tool.define("invalid", {
  description: "Do not use",
  parameters: z.object({
    tool: z.string(),
    error: z.string(),
  }),
  async execute(params) {
    return {
      title: "Invalid Tool",
      output: success(`The arguments provided to the tool are invalid: ${params.error}`),
      metadata: {},
    }
  },
})
