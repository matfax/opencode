export * from "./gen/types.gen.js"
export { type Config as OpencodeClientConfig }

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient as GeneratedOpencodeClient } from "./gen/sdk.gen.js"
import type { Options } from "./gen/sdk.gen.js"
import type { PostSessionIdPermissionsPermissionIdData } from "./gen/types.gen.js"

// Type for the permissions helper
interface SessionPermissions {
  respond<ThrowOnError extends boolean = false>(
    options: Options<PostSessionIdPermissionsPermissionIdData, ThrowOnError>
  ): ReturnType<GeneratedOpencodeClient["postSessionIdPermissionsPermissionId"]>
}

export class OpencodeClient extends GeneratedOpencodeClient {
  declare session: GeneratedOpencodeClient["session"] & {
    permissions: SessionPermissions
  }

  constructor(args?: { client?: ReturnType<typeof createClient> }) {
    super(args)

    // Extend session object with permissions helper
    const originalSession = this.session
    const client = this
    this.session = Object.assign(originalSession, {
      permissions: {
        respond<ThrowOnError extends boolean = false>(
          options: Options<PostSessionIdPermissionsPermissionIdData, ThrowOnError>
        ) {
          return client.postSessionIdPermissionsPermissionId<ThrowOnError>(options)
        }
      }
    })
  }
}

export function createOpencodeClient(config?: Config) {
  const client = createClient(config)
  return new OpencodeClient({ client })
}
