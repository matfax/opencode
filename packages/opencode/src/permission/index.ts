import z from "zod/v4"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { Identifier } from "../id/id"
import { Plugin } from "../plugin"
import { Instance } from "../project/instance"
import { Wildcard } from "../util/wildcard"

export namespace Permission {
  const log = Log.create({ service: "permission" })

  function toKeys(pattern: Info["pattern"], type: string): string[] {
    return pattern === undefined ? [type] : Array.isArray(pattern) ? pattern : [pattern]
  }

  function covered(keys: string[], approved: Record<string, boolean>): boolean {
    const pats = Object.keys(approved)
    return keys.every((k) => pats.some((p) => Wildcard.match(k, p)))
  }

  export const Info = z
    .object({
      id: z.string(),
      type: z.string(),
      pattern: z.union([z.string(), z.array(z.string())]).optional(),
      sessionID: z.string(),
      messageID: z.string(),
      callID: z.string().optional(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        created: z.number(),
      }),
    })
    .meta({
      ref: "Permission",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: Bus.event("permission.updated", Info),
    Replied: Bus.event(
      "permission.replied",
      z.object({ sessionID: z.string(), permissionID: z.string(), response: z.string() }),
    ),
  }

  const state = Instance.state(
    () => {
      const pending: {
        [sessionID: string]: {
          [permissionID: string]: {
            info: Info
            resolve: () => void
            reject: (e: any) => void
          }
        }
      } = {}

      const approved: {
        [sessionID: string]: {
          [permissionID: string]: boolean
        }
      } = {}

      return {
        pending,
        approved,
      }
    },
    async (state) => {
      for (const pending of Object.values(state.pending)) {
        for (const item of Object.values(pending)) {
          item.reject(new RejectedError(item.info.sessionID, item.info.id, item.info.callID, item.info.metadata))
        }
      }
    },
  )

  export async function ask(input: {
    type: Info["type"]
    title: Info["title"]
    pattern?: Info["pattern"]
    callID?: Info["callID"]
    sessionID: Info["sessionID"]
    messageID: Info["messageID"]
    metadata: Info["metadata"]
    strict?: boolean
  }) {
    const { pending, approved } = state()
    log.info("asking", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      toolCallID: input.callID,
      pattern: input.pattern,
      strict: input.strict,
    })
    const approvedForSession = approved[input.sessionID] || {}
    const keys = toKeys(input.pattern, input.type)
    // If strict mode is enabled, skip the "always" approval check
    if (!input.strict && covered(keys, approvedForSession)) return
    const info: Info = {
      id: Identifier.ascending("permission"),
      type: input.type,
      pattern: input.pattern,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      title: input.title,
      metadata: input.metadata,
      time: {
        created: Date.now(),
      },
    }

    switch (
      await Plugin.trigger("permission.ask", info, {
        status: "ask",
      }).then((x) => x.status)
    ) {
      case "deny":
        throw new RejectedError(info.sessionID, info.id, info.callID, info.metadata)
      case "allow":
        return
    }

    pending[input.sessionID] = pending[input.sessionID] || {}
    return new Promise<void>((resolve, reject) => {
      pending[input.sessionID][info.id] = {
        info,
        resolve,
        reject,
      }
      Bus.publish(Event.Updated, info)
    })
  }

  export const Response = z.enum(["once", "always", "reject"])
  export type Response = z.infer<typeof Response>

  export const RejectReason = z.enum(["syntax", "approach", "intent", "custom"])
  export type RejectReason = z.infer<typeof RejectReason>

  export function respond(input: {
    sessionID: Info["sessionID"]
    permissionID: Info["id"]
    response: Response
    reason?: string
    rejectType?: RejectReason
  }) {
    log.info("response", input)
    const { pending, approved } = state()
    const match = pending[input.sessionID]?.[input.permissionID]
    if (!match) return
    delete pending[input.sessionID][input.permissionID]
    if (input.response === "reject") {
      let error: RejectedError
      switch (input.rejectType) {
        case "syntax":
          error = new RejectedSyntaxError(
            input.sessionID,
            input.permissionID,
            match.info.callID,
            match.info.metadata,
            input.reason,
          )
          break
        case "approach":
          error = new RejectedApproachError(
            input.sessionID,
            input.permissionID,
            match.info.callID,
            match.info.metadata,
            input.reason,
          )
          break
        case "intent":
          error = new RejectedIntentError(
            input.sessionID,
            input.permissionID,
            match.info.callID,
            match.info.metadata,
            input.reason,
          )
          break
        case "custom":
          error = new RejectedCustomError(
            input.sessionID,
            input.permissionID,
            match.info.callID,
            match.info.metadata,
            input.reason,
          )
          break
        default:
          error = new RejectedError(
            input.sessionID,
            input.permissionID,
            match.info.callID,
            match.info.metadata,
            input.reason,
          )
      }
      match.reject(error)
      return
    }
    match.resolve()
    Bus.publish(Event.Replied, {
      sessionID: input.sessionID,
      permissionID: input.permissionID,
      response: input.response,
    })
    if (input.response === "always") {
      approved[input.sessionID] = approved[input.sessionID] || {}
      const approveKeys = toKeys(match.info.pattern, match.info.type)
      for (const k of approveKeys) {
        approved[input.sessionID][k] = true
      }
      const items = pending[input.sessionID]
      if (!items) return
      for (const item of Object.values(items)) {
        const itemKeys = toKeys(item.info.pattern, item.info.type)
        if (covered(itemKeys, approved[input.sessionID])) {
          respond({ sessionID: item.info.sessionID, permissionID: item.info.id, response: input.response })
        }
      }
    }
  }

  export class RejectedError extends Error {
    public readonly rejectType?: RejectReason

    constructor(
      public readonly sessionID: string,
      public readonly permissionID: string,
      public readonly toolCallID?: string,
      public readonly metadata?: Record<string, any>,
      public readonly reason?: string,
      rejectType?: RejectReason,
    ) {
      super(
        reason ||
          "The user rejected permission to use this specific tool call. You may try again with different parameters.",
      )
      this.name = "RejectedError"
      this.rejectType = rejectType
    }
  }

  export class RejectedSyntaxError extends RejectedError {
    constructor(
      sessionID: string,
      permissionID: string,
      toolCallID?: string,
      metadata?: Record<string, any>,
      customReason?: string,
    ) {
      const message = `The user rejected this due to a syntax error. ${customReason || "Please fix the syntax and try again."}`
      super(sessionID, permissionID, toolCallID, metadata, message, "syntax")
      this.name = "RejectedSyntaxError"
    }
  }

  export class RejectedApproachError extends RejectedError {
    constructor(
      sessionID: string,
      permissionID: string,
      toolCallID?: string,
      metadata?: Record<string, any>,
      customReason?: string,
    ) {
      const message = `The user rejected this approach. ${customReason || "The user agrees with the intent but wants a different implementation approach. Do not retry the same approach."}`
      super(sessionID, permissionID, toolCallID, metadata, message, "approach")
      this.name = "RejectedApproachError"
    }
  }

  export class RejectedIntentError extends RejectedError {
    constructor(
      sessionID: string,
      permissionID: string,
      toolCallID?: string,
      metadata?: Record<string, any>,
      customReason?: string,
    ) {
      const message = `The user rejected this intent. ${customReason || "Do not pursue this direction or similar approaches. The user does not want this functionality."}`
      super(sessionID, permissionID, toolCallID, metadata, message, "intent")
      this.name = "RejectedIntentError"
    }
  }

  export class RejectedCustomError extends RejectedError {
    constructor(
      sessionID: string,
      permissionID: string,
      toolCallID?: string,
      metadata?: Record<string, any>,
      customReason?: string,
    ) {
      const message = customReason || "The user rejected permission to use this specific tool call."
      super(sessionID, permissionID, toolCallID, metadata, message, "custom")
      this.name = "RejectedCustomError"
    }
  }
}
