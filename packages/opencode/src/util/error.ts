import z from "zod/v4"
// import { Log } from "./log"

// const log = Log.create()

export abstract class NamedError extends Error {
  abstract schema(): z.core.$ZodType
  abstract toObject(): { name: string; data: any }

  static create<Name extends string, Data extends z.core.$ZodType>(name: Name, data: Data) {
    const schema = z
      .object({
        name: z.literal(name),
        data,
      })
      .meta({
        ref: name,
      })
    const result = class extends NamedError {
      public static readonly Schema = schema

      public readonly name = name as Name

      constructor(
        public readonly data: z.input<Data>,
        options?: ErrorOptions,
      ) {
        super(name, options)
        this.name = name
      }

      static isInstance(input: any): input is InstanceType<typeof result> {
        return "name" in input && input.name === name
      }

      schema() {
        return schema
      }

      toObject() {
        return {
          name: name,
          data: this.data,
        }
      }
    }
    Object.defineProperty(result, "name", { value: name })
    return result
  }

  public static readonly Unknown = NamedError.create(
    "UnknownError",
    z.object({
      message: z.string(),
    }),
  )
}

/**
 * Extract a clean error message from AI SDK errors
 * Handles responseBody parsing and extracts just the error message
 * without exposing internal error object properties
 */
export function extractAISDKErrorMessage(err: any, context: string): string {
  if (err?.responseBody) {
    try {
      const body = typeof err.responseBody === "string" ? JSON.parse(err.responseBody) : err.responseBody
      return `${context}: ${body.error?.message || body.message || JSON.stringify(body)}`
    } catch {
      return `${context}: ${String(err.responseBody)}`
    }
  }
  return err?.message || String(err)
}
