import z from "zod/v4"

export namespace Tool {
  interface Metadata {
    [key: string]: any
  }
  export type Context<M extends Metadata = Metadata> = {
    sessionID: string
    messageID: string
    agent: string
    callID?: string
    abort: AbortSignal
    extra?: { [key: string]: any }
    metadata(input: { title?: string; metadata?: M; clear?: boolean }): void
  }
  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
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
        output: string
      }>
    }>
  }

  export function define<Parameters extends z.ZodType, Result extends Metadata>(
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
}
