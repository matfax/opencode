export * from "./gen/types.gen.js"
export { type Config as OpencodeClientConfig }

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient as GeneratedOpencodeClient } from "./gen/sdk.gen.js"
import type { PostSessionIdPermissionsPermissionIdData, PostSessionIdPermissionsPermissionIdResponses } from "./gen/types.gen.js"

class SessionPermissions {
  constructor(private client: GeneratedOpencodeClient) {}

  respond<ThrowOnError extends boolean = false>(
    options: Omit<PostSessionIdPermissionsPermissionIdData, "url">
  ) {
    return this.client.postSessionIdPermissionsPermissionId<ThrowOnError>({
      ...options,
      url: "/session/{id}/permissions/{permissionID}",
    })
  }
}

export class OpencodeClient extends GeneratedOpencodeClient {
  private _sessionPermissions: SessionPermissions

  constructor(args?: { client?: ReturnType<typeof createClient> }) {
    super(args)
    this._sessionPermissions = new SessionPermissions(this)
  }

  get session() {
    const baseSession = super.session
    return {
      ...baseSession,
      permissions: this._sessionPermissions,
    }
  }
}

export function createOpencodeClient(config?: Config) {
  const client = createClient(config)
  return new OpencodeClient({ client })
}
