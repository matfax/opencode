import z from "zod/v4"
import type { ToolMetadata, ToolOutput } from "./metadata"

export namespace Tool {
  export type Context<M extends ToolMetadata = ToolMetadata> = {
    sessionID: string
    messageID: string
    agent: string
    callID?: string
    abort: AbortSignal
    extra?: { [key: string]: any }
    metadata(input: { title?: string; metadata?: Partial<M>; clear?: boolean }): void
  }
  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends ToolMetadata = ToolMetadata> {
    id: string
    init: () => Promise<{
      description: string
      parameters: Parameters
      // Optional stable key builder for supersede/manual refresh
      key?: (args: z.infer<Parameters>) => string | undefined
      // Optional auto-refresh enabler; only used if key() present
      enableRefresh?: (args: z.infer<Parameters>) => boolean
      // Optional expiration after N messages; returns message count or undefined for no expiration
      expireAfter?: (args: z.infer<Parameters>) => number | undefined
      execute(
        args: z.infer<Parameters>,
        ctx: Context,
      ): Promise<{
        title: string
        metadata: M
        output: ToolOutput
        childSessionID?: string
      }>
    }>
  }

  export function define<Parameters extends z.ZodType, Result extends ToolMetadata>(
    id: string,
    init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
  ): Info<Parameters, Result> {
    return {
      id,
      init: async () => {
        if (init instanceof Function) return init()
        return init
      },
    }
  }

  export interface ToAISDKOptions<M extends ToolMetadata = ToolMetadata> {
    /** Override the tool description */
    description?: string
    /** Keys of parameters to omit from the schema */
    omitParams?: string[]
    /** Custom parameter schema transformer */
    transformParams?: (schema: z.ZodType) => z.ZodType
    /** Custom result mapper */
    mapResult?: (result: { title: string; metadata: M; output: ToolOutput }) => { output: ToolOutput; metadata: Partial<M>; title?: string }
    /** Default parameter values to merge with provided params */
    defaultParams?: Record<string, any>
  }

  /**
   * Convert a Tool.Info to an AI SDK compatible tool
   * Supports parameter filtering and schema transformation
   */
  export async function toAISDKTool<P extends z.ZodType, M extends ToolMetadata>(
    toolInfo: Info<P, M>,
    ctx: Context<M>,
    options: ToAISDKOptions<M> = {},
  ): Promise<{
    description?: string
    inputSchema: z.ZodType
    execute: (params: any) => Promise<{ output: ToolOutput; metadata: Partial<M>; title?: string }>
  }> {
    const initialized = await toolInfo.init()

    let schema: z.ZodType = initialized.parameters

    // Apply parameter omission if specified
    if (options.omitParams && options.omitParams.length > 0) {
      // For ZodObject types, we can use .omit()
      if (schema instanceof z.ZodObject) {
        const omitObj = options.omitParams.reduce(
          (acc, key) => {
            acc[key] = true
            return acc
          },
          {} as Record<string, true>,
        )
        schema = schema.omit(omitObj) as z.ZodType
      } else {
        throw new Error("omitParams only works with ZodObject schemas")
      }
    }

    // Apply custom transformer if specified
    if (options.transformParams) {
      schema = options.transformParams(schema)
    }

    return {
      description: options.description ?? initialized.description,
      inputSchema: schema,
      execute: async (params: any) => {
        try {
          // Merge default params with provided params
          const mergedParams = options.defaultParams ? { ...options.defaultParams, ...params } : params
          const result = await initialized.execute(mergedParams, ctx)

          // Apply custom result mapper if specified
          if (options.mapResult) {
            return options.mapResult(result)
          }

          // Default mapping: nest metadata and output for AI SDK compatibility
          return {
            output: result.output,
            metadata: result.metadata,
            title: result.title,
          }
        } catch (err: any) {
          return {
            output: err instanceof Error ? err : new Error(String(err)),
            metadata: {} as Partial<M>,
          }
        }
      },
    }
  }
}
