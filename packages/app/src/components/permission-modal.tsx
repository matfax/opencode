import { Button } from "@/ui"
import { createSignal, Show, type Component } from "solid-js"
import type { Permission } from "@opencode-ai/sdk"
import { useSDK } from "@/context"

type RejectType = "syntax" | "approach" | "intent" | "custom"

export const PermissionModal: Component<{
  permission: Permission
  onClose: () => void
}> = (props) => {
  const sdk = useSDK()
  const [rejectType, setRejectType] = createSignal<RejectType | null>(null)
  const [reason, setReason] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)

  const handleApprove = async (always: boolean) => {
    setSubmitting(true)
    try {
      await sdk.session.permissions.respond({
        path: {
          id: props.permission.sessionID,
          permissionID: props.permission.id,
        },
        body: {
          response: always ? "always" : "once",
        },
      })
      props.onClose()
    } catch (error) {
      console.error("Failed to respond to permission:", error)
    } finally {
      setSubmitting(false)
    }
  }

  const handleReject = async () => {
    const type = rejectType()
    if (!type) return

    setSubmitting(true)
    try {
      await sdk.session.permissions.respond({
        path: {
          id: props.permission.sessionID,
          permissionID: props.permission.id,
        },
        body: {
          response: "reject",
          rejectType: type,
          reason: reason() || undefined,
        },
      })
      props.onClose()
    } catch (error) {
      console.error("Failed to respond to permission:", error)
    } finally {
      setSubmitting(false)
    }
  }

  const rejectTypeLabels: Record<RejectType, { title: string; description: string }> = {
    syntax: {
      title: "Syntax Error",
      description: "The code has syntax errors that need to be fixed",
    },
    approach: {
      title: "Wrong Approach",
      description: "The intent is correct but the implementation approach needs to change",
    },
    intent: {
      title: "Wrong Intent",
      description: "This is not what I want - don't pursue this direction",
    },
    custom: {
      title: "Custom Reason",
      description: "Provide your own specific reason for rejection",
    },
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => !submitting() && props.onClose()}
    >
      <div
        class="relative max-w-2xl w-full mx-4 bg-background-panel rounded-lg shadow-2xl ring-1 ring-border-subtle"
        onClick={(e) => e.stopPropagation()}
      >
        <Show
          when={!rejectType()}
          fallback={
            <div class="p-6">
              <h2 class="text-lg font-semibold text-text mb-2">
                {rejectTypeLabels[rejectType()!].title}
              </h2>
              <p class="text-sm text-text-muted mb-4">
                {rejectTypeLabels[rejectType()!].description}
              </p>

              <div class="mb-4">
                <label class="block text-sm font-medium text-text mb-2">
                  Reason (optional)
                </label>
                <textarea
                  value={reason()}
                  onInput={(e) => setReason(e.currentTarget.value)}
                  placeholder="Provide additional context for the AI..."
                  class="w-full px-3 py-2 bg-background text-text rounded-md border border-border-subtle
                         focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary
                         placeholder-text-muted/60 resize-none"
                  rows={3}
                  disabled={submitting()}
                />
              </div>

              <div class="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setRejectType(null)}
                  disabled={submitting()}
                >
                  Back
                </Button>
                <Button
                  variant="primary"
                  onClick={handleReject}
                  disabled={submitting()}
                >
                  {submitting() ? "Submitting..." : "Submit Rejection"}
                </Button>
              </div>
            </div>
          }
        >
          <div class="p-6">
            <div class="flex items-start justify-between mb-4">
              <div>
                <h2 class="text-lg font-semibold text-text">Permission Required</h2>
                <p class="text-sm text-text-muted mt-1">{props.permission.title}</p>
              </div>
            </div>

            <div class="space-y-3 mb-6">
              <div class="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => handleApprove(false)}
                  disabled={submitting()}
                  class="flex-1"
                >
                  Approve Once
                </Button>
                <Button
                  variant="primary"
                  onClick={() => handleApprove(true)}
                  disabled={submitting()}
                  class="flex-1"
                >
                  Approve Always
                </Button>
              </div>

              <div class="relative">
                <div class="absolute inset-0 flex items-center">
                  <div class="w-full border-t border-border-subtle" />
                </div>
                <div class="relative flex justify-center text-xs uppercase">
                  <span class="bg-background-panel px-2 text-text-muted">Or Reject</span>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setRejectType("syntax")}
                  disabled={submitting()}
                  class="justify-start"
                >
                  <div class="text-left">
                    <div class="font-medium">Syntax Error</div>
                    <div class="text-xs text-text-muted">Fix syntax issues</div>
                  </div>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setRejectType("approach")}
                  disabled={submitting()}
                  class="justify-start"
                >
                  <div class="text-left">
                    <div class="font-medium">Wrong Approach</div>
                    <div class="text-xs text-text-muted">Different implementation</div>
                  </div>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setRejectType("intent")}
                  disabled={submitting()}
                  class="justify-start"
                >
                  <div class="text-left">
                    <div class="font-medium">Wrong Intent</div>
                    <div class="text-xs text-text-muted">Don't want this</div>
                  </div>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setRejectType("custom")}
                  disabled={submitting()}
                  class="justify-start"
                >
                  <div class="text-left">
                    <div class="font-medium">Custom Reason</div>
                    <div class="text-xs text-text-muted">Provide details</div>
                  </div>
                </Button>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}