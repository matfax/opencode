import { useLocal, useSync } from "@/context"
import { Collapsible, Icon, type IconProps } from "@/ui"
import type { Part, ToolPart } from "@opencode-ai/sdk"
import { DateTime } from "luxon"
import {
  createSignal,
  onMount,
  For,
  Match,
  splitProps,
  Switch,
  type ComponentProps,
  type ParentProps,
  createEffect,
  createMemo,
} from "solid-js"
import { getFilename } from "@/utils"
import Markdown from "./markdown"
import { Code } from "./code"
import { createElementSize } from "@solid-primitives/resize-observer"
import { createScrollPosition } from "@solid-primitives/scroll"

function TimelineIcon(props: { name: IconProps["name"]; class?: string }) {
  return (
    <div
      classList={{
        "relative flex flex-none self-start items-center justify-center bg-background h-6 w-6": true,
        [props.class ?? ""]: !!props.class,
      }}
    >
      <Icon name={props.name} class="text-text/40" size={18} />
    </div>
  )
}

function CollapsibleTimelineIcon(props: { name: IconProps["name"]; class?: string }) {
  return (
    <>
      <TimelineIcon
        name={props.name}
        class={`group-hover/li:hidden group-has-[[data-expanded]]/li:hidden ${props.class ?? ""}`}
      />
      <TimelineIcon
        name="chevron-right"
        class={`hidden group-hover/li:flex group-has-[[data-expanded]]/li:hidden ${props.class ?? ""}`}
      />
      <TimelineIcon name="chevron-down" class={`hidden group-has-[[data-expanded]]/li:flex ${props.class ?? ""}`} />
    </>
  )
}

function ToolIcon(props: { part: ToolPart }) {
  return (
    <Switch fallback={<TimelineIcon name="hammer" />}>
      <Match when={props.part.tool === "read"}>
        <TimelineIcon name="file" />
      </Match>
      <Match when={props.part.tool === "edit"}>
        <CollapsibleTimelineIcon name="pencil" />
      </Match>
      <Match when={props.part.tool === "write"}>
        <CollapsibleTimelineIcon name="file-plus" />
      </Match>
      <Match when={props.part.tool === "bash"}>
        <CollapsibleTimelineIcon name="terminal" />
      </Match>
    </Switch>
  )
}

function Part(props: ParentProps & ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class", "classList", "children"])
  return (
    <div
      classList={{
        ...(local.classList ?? {}),
        "h-6 flex items-center": true,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    >
      <p class="text-xs leading-4 text-left text-text-muted/60 font-medium">{local.children}</p>
    </div>
  )
}

function CollapsiblePart(props: { title: ParentProps["children"] } & ParentProps & ComponentProps<typeof Collapsible>) {
  return (
    <Collapsible {...props}>
      <Collapsible.Trigger class="peer/collapsible">
        <Part>{props.title}</Part>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <p class="flex-auto py-1 text-xs min-w-0 text-pretty">
          <span class="text-text-muted/60 break-words">{props.children}</span>
        </p>
      </Collapsible.Content>
    </Collapsible>
  )
}

function ReadToolPart(props: { part: ToolPart }) {
  const local = useLocal()
  return (
    <Switch>
      <Match when={props.part.state.status === "completed" && props.part.state}>
        {(state) => {
          const path = state().input["filePath"] as string
          return (
            <Part class="cursor-pointer" onClick={() => local.file.open(path)}>
              <span class="text-text-muted">Read</span> {getFilename(path)}
            </Part>
          )
        }}
      </Match>
    </Switch>
  )
}

function EditToolPart(props: { part: ToolPart }) {
  return (
    <Switch>
      <Match when={props.part.state.status === "completed" && props.part.state}>
        {(state) => (
          <CollapsiblePart
            defaultOpen
            title={
              <>
                <span class="text-text-muted">Edit</span> {getFilename(state().input["filePath"] as string)}
              </>
            }
          >
            {/* Always render as diff */}
            <Code
              path={state().input["filePath"] as string}
              code={state().metadata["diff"] as string}
              class="[&_code]:pb-0!"
            />
          </CollapsiblePart>
        )}
      </Match>
    </Switch>
  )
}

function WriteToolPart(props: { part: ToolPart }) {
  return (
    <Switch>
      <Match when={props.part.state.status === "completed" && props.part.state}>
        {(state) => (
          <CollapsiblePart
            title={
              <>
                <span class="text-text-muted">Write</span> {getFilename(state().input["filePath"] as string)}
              </>
            }
          >
            <div class="p-2 bg-background-panel rounded-md border border-border-subtle"></div>
          </CollapsiblePart>
        )}
      </Match>
    </Switch>
  )
}

function CommandOutputOverlay(props: {
  command: string
  output: string
  exitCode: number | undefined
  isExecuting: boolean
  onClose: () => void
}) {
  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        class="bg-background-panel border border-border-subtle rounded-lg shadow-2xl max-w-4xl w-full max-h-[80vh] flex flex-col m-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="flex items-center justify-between p-4 border-b border-border-subtle">
          <div class="flex items-center gap-2 flex-1 min-w-0">
            <span class="font-mono text-sm text-text">$ {props.command}</span>
            {props.isExecuting && <span class="text-yellow-500 text-sm">...</span>}
            {props.exitCode !== undefined && (
              <span
                classList={{
                  "text-sm font-semibold": true,
                  "text-green-500": props.exitCode === 0,
                  "text-red-500": props.exitCode !== 0,
                }}
              >
                [{props.exitCode}]
              </span>
            )}
          </div>
          <button
            class="text-text-muted hover:text-text transition-colors"
            onClick={props.onClose}
            aria-label="Close"
          >
            <Icon name="close" class="w-5 h-5" />
          </button>
        </div>

        {/* Output */}
        <div class="flex-1 overflow-auto p-4">
          <Code code={props.output || "(no output yet)"} path="output.sh" class="text-sm" />
        </div>
      </div>
    </div>
  )
}

type BashStep = {
  text: string
  exitCode?: number
  type: "command" | "text-delta"
}

type BashSegment =
  | { kind: "command"; step: BashStep }
  | { kind: "reasoning"; text: string }

function BashToolPart(props: { part: ToolPart }) {
  const metadata = createMemo<Record<string, unknown> | undefined>(() => {
    const maybe = (props.part.state as { metadata?: unknown }).metadata
    if (!maybe || typeof maybe !== "object") return undefined
    return maybe as Record<string, unknown>
  })

  const input = createMemo<Record<string, unknown> | undefined>(() => {
    const maybe = (props.part.state as { input?: unknown }).input
    if (!maybe || typeof maybe !== "object") return undefined
    return maybe as Record<string, unknown>
  })

  const status = () => props.part.state.status
  const isRunning = () => status() === "running"
  const isPending = () => status() === "pending"

  const steps = createMemo<BashStep[]>(() => {
    const raw = metadata()?.["steps"]
    if (!Array.isArray(raw)) return []
    return raw.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return []
      const record = entry as Record<string, unknown>
      const type = typeof record["type"] === "string" ? (record["type"] as BashStep["type"]) : "text-delta"
      if (type !== "command" && type !== "text-delta") return []
      const text = typeof record["text"] === "string" ? (record["text"] as string) : ""
      const exitRaw = record["exitCode"]
      const exitCode = typeof exitRaw === "number" ? exitRaw : undefined
      return [{ text, exitCode, type }]
    })
  })

  const fallbackCommand = createMemo(() => {
    const command = input()?.["command"]
    if (typeof command !== "string") return undefined
    const trimmed = command.trim()
    if (trimmed === "") return undefined
    return trimmed
  })

  const segments = createMemo<BashSegment[]>(() => {
    const collected = steps().reduce(
      (acc, step) => {
        if (step.type === "text-delta") {
          return { list: acc.list, text: acc.text + step.text }
        }
        if (step.type === "command") {
          const trimmed = acc.text.trim()
          const list = trimmed === ""
            ? acc.list
            : [...acc.list, { kind: "reasoning" as const, text: trimmed }]
          return { list: [...list, { kind: "command" as const, step }], text: "" }
        }
        return acc
      },
      { list: [] as BashSegment[], text: "" }
    )

    const list = collected.text.trim() === ""
      ? collected.list
      : [...collected.list, { kind: "reasoning" as const, text: collected.text.trim() }]

    if (list.length > 0) return list
    const command = fallbackCommand()
    if (!command) return list
    return [{ kind: "command", step: { text: command, type: "command" } }]
  })

  const commandMap = createMemo(() => {
    const raw = metadata()?.["commands"]
    if (!raw || typeof raw !== "object") return {} as Record<string, { output: string; exitCode?: number }>
    const result: Record<string, { output: string; exitCode?: number }> = {}
    for (const [cmd, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue
      const record = value as Record<string, unknown>
      const output = typeof record["output"] === "string" ? (record["output"] as string) : ""
      const exitRaw = record["exitCode"]
      const exitCode = typeof exitRaw === "number" ? exitRaw : undefined
      result[cmd] = { output, exitCode }
    }
    return result
  })

  const statusText = createMemo(() => {
    if (!isRunning()) return undefined
    const value = metadata()?.["status"]
    if (typeof value === "string" && value.trim() !== "") return `🔄 ${value}`
    return "🔄 Starting"
  })

  const instructionText = createMemo(() => {
    if (!isRunning()) return undefined
  const target = input()
    if (!target) return undefined
    const keys = ["instructions", "goal", "description"] as const
    const key = keys.find((item) => {
      const value = target[item]
      return typeof value === "string" && value.trim() !== ""
    })
    if (!key) return undefined
    return (target[key] as string).trim()
  })

  const goalText = createMemo(() => {
    if (isPending()) return undefined
  const value = input()?.["goal"]
    if (typeof value !== "string") return undefined
    const trimmed = value.trim()
    if (trimmed === "") return undefined
    const instruction = instructionText()
    if (instruction && instruction === trimmed) return undefined
    return trimmed
  })

  const attemptInfo = createMemo(() => {
  const meta = metadata()
    const attemptRaw = meta?.["attempt"]
    const maxRaw = meta?.["maxRetries"]
    if (typeof attemptRaw !== "number" || typeof maxRaw !== "number") return undefined
    if (attemptRaw <= 1 || maxRaw <= 1) return undefined
    return { attempt: Math.trunc(attemptRaw), max: Math.trunc(maxRaw) }
  })

  const [overlayCommand, setOverlayCommand] = createSignal<string | null>(null)

  const errorMessage = createMemo(() => {
    if (status() !== "error") return undefined
    const value = (props.part.state as { error?: unknown }).error
    if (typeof value !== "string") return undefined
    return value
  })

  return (
    <>
      <Match when={overlayCommand()}>
        {(cmd) => {
          const map = commandMap()
          const data = map[cmd()]
          const segment = segments().find(
            (item): item is Extract<BashSegment, { kind: "command" }> => item.kind === "command" && item.step.text === cmd(),
          )
          const exitCode = data?.exitCode ?? segment?.step.exitCode
          return (
            <CommandOutputOverlay
              command={cmd()}
              output={data?.output ?? ""}
              exitCode={exitCode}
              isExecuting={data?.exitCode === undefined}
              onClose={() => setOverlayCommand(null)}
            />
          )
        }}
      </Match>

      <Match when={statusText()}>
        {(text) => <div class="text-xs font-semibold text-accent mb-2">{text()}</div>}
      </Match>

      <Match when={instructionText()}>
        {(text) => (
          <div class="text-xs text-text-muted/70 mb-2">
            ℹ️ {text()}
          </div>
        )}
      </Match>

      <Match when={goalText()}>
        {(text) => (
          <div class="text-xs font-semibold text-text mb-2">
            Goal: {text()}
          </div>
        )}
      </Match>

      <Match when={attemptInfo()}>
        {(info) => (
          <div class="mb-2 inline-flex items-center">
            <span class="bg-accent text-background font-semibold text-[10px] px-2 py-0.5 rounded">
              Attempt {info().attempt}/{info().max}
            </span>
          </div>
        )}
      </Match>

      <For each={segments()}>
        {(segment) => {
          if (segment.kind === "reasoning") {
            return (
              <div class="mt-2 p-2 bg-background-panel rounded border border-border-subtle text-xs">
                <Markdown
                  text={segment.text}
                  class={isRunning() ? "text-text-muted" : "text-accent"}
                />
              </div>
            )
          }

          const map = commandMap()
          const data = map[segment.step.text]
          const exitCode = data?.exitCode ?? segment.step.exitCode
          const isExecutingCommand = data?.exitCode === undefined
          const output = data?.output ?? ""
          const lines = output.split("\n").filter((line) => line.trim() !== "")
          const lastLine = lines[lines.length - 1]

          return (
            <div
              class="border border-border-subtle rounded bg-background-panel p-3 mb-2 cursor-pointer hover:border-accent transition-colors"
              onClick={() => setOverlayCommand(segment.step.text)}
            >
              <div class="flex items-center gap-2 mb-1">
                <span class="font-mono text-xs text-text-muted">$ {segment.step.text}</span>
                {isExecutingCommand && <span class="text-yellow-500 text-xs">...</span>}
                {exitCode !== undefined && (
                  <span
                    classList={{
                      "text-xs font-semibold": true,
                      "text-green-500": exitCode === 0,
                      "text-red-500": exitCode !== 0,
                    }}
                  >
                    [{exitCode}]
                  </span>
                )}
              </div>
              <div class="text-xs text-text-muted/80 font-mono truncate">
                {lastLine || (isExecutingCommand ? "(executing...)" : "(no output)")}
              </div>
            </div>
          )
        }}
      </For>

      <Match when={errorMessage()}>
        {(err) => (
          <div class="mt-2 p-2 bg-background-panel rounded border border-red-500 text-xs text-red-500">
            ⚠️ {err()}
          </div>
        )}
      </Match>
    </>
  )
}

function ToolPart(props: { part: ToolPart }) {
  return (
    <Switch
      fallback={
        <div class="flex-auto min-w-0 text-xs">
          {props.part.type}:{props.part.tool}
        </div>
      }
    >
      <Match when={props.part.tool === "read"}>
        <div class="min-w-0 flex-auto">
          <ReadToolPart part={props.part} />
        </div>
      </Match>
      <Match when={props.part.tool === "edit"}>
        <div class="min-w-0 flex-auto">
          <EditToolPart part={props.part} />
        </div>
      </Match>
      <Match when={props.part.tool === "write"}>
        <div class="min-w-0 flex-auto">
          <WriteToolPart part={props.part} />
        </div>
      </Match>
      <Match when={props.part.tool === "bash"}>
        <div class="min-w-0 flex-auto">
          <BashToolPart part={props.part} />
        </div>
      </Match>
    </Switch>
  )
}

export default function SessionTimeline(props: { session: string; class?: string }) {
  const sync = useSync()
  const [scrollElement, setScrollElement] = createSignal<HTMLElement | undefined>(undefined)
  const [root, setRoot] = createSignal<HTMLDivElement | undefined>(undefined)
  const [tail, setTail] = createSignal(true)
  const size = createElementSize(root)
  const scroll = createScrollPosition(scrollElement)

  onMount(() => sync.session.sync(props.session))
  const messages = createMemo(() => sync.data.message[props.session] ?? [])
  const working = createMemo(() => {
    const last = messages()[messages().length - 1]
    if (!last) return false
    if (last.role === "user") return true
    return !last.time.completed
  })

  const getScrollParent = (el: HTMLElement | null): HTMLElement | undefined => {
    let p = el?.parentElement
    while (p && p !== document.body) {
      const s = getComputedStyle(p)
      if (s.overflowY === "auto" || s.overflowY === "scroll") return p
      p = p.parentElement
    }
    return undefined
  }

  createEffect(() => {
    if (!root()) return
    setScrollElement(getScrollParent(root()!))
  })

  const scrollToBottom = () => {
    const element = scrollElement()
    if (!element) return
    element.scrollTop = element.scrollHeight
  }

  createEffect(() => {
    size.height
    if (tail()) scrollToBottom()
  })

  createEffect(() => {
    if (working()) {
      setTail(true)
      scrollToBottom()
    }
  })

  let lastScrollY = 0
  createEffect(() => {
    if (scroll.y < lastScrollY) {
      setTail(false)
    }
    lastScrollY = scroll.y
  })

  const valid = (part: Part) => {
    if (!part) return false
    switch (part.type) {
      case "step-start":
      case "step-finish":
      case "file":
      case "patch":
        return false
      case "text":
        return !part.synthetic
      case "reasoning":
        return part.text.trim()
      default:
        return true
    }
  }

  const duration = (part: Part) => {
    switch (part.type) {
      default:
        if (
          "time" in part &&
          part.time &&
          "start" in part.time &&
          part.time.start &&
          "end" in part.time &&
          part.time.end
        ) {
          const start = DateTime.fromMillis(part.time.start)
          const end = DateTime.fromMillis(part.time.end)
          return end.diff(start).toFormat("s")
        }
        return ""
    }
  }

  return (
    <div
      ref={setRoot}
      classList={{
        "p-4 select-text flex flex-col gap-y-8": true,
        [props.class ?? ""]: !!props.class,
      }}
    >
      <For each={messages()}>
        {(message) => (
          <ul role="list" class="space-y-2">
            <For each={sync.data.part[message.id]?.filter(valid)}>
              {(part) => (
                <li classList={{ "relative group/li flex gap-x-4 min-w-0 w-full": true }}>
                  <div
                    classList={{
                      "absolute top-0 left-0 flex w-6 justify-center": true,
                      "last:h-10 not-last:-bottom-10": true,
                    }}
                  >
                    <div class="w-px bg-border-subtle" />
                  </div>
                  <Switch
                    fallback={
                      <div class="m-0.5 relative flex size-5 flex-none items-center justify-center bg-background">
                        <div class="size-1 rounded-full bg-text/10 ring ring-text/20" />
                      </div>
                    }
                  >
                    <Match when={part.type === "text"}>
                      <Switch>
                        <Match when={message.role === "user"}>
                          <TimelineIcon name="avatar-square" />
                        </Match>
                        <Match when={message.role === "assistant"}>
                          <TimelineIcon name="sparkles" />
                        </Match>
                      </Switch>
                    </Match>
                    <Match when={part.type === "reasoning"}>
                      <CollapsibleTimelineIcon name="brain" />
                    </Match>
                    <Match when={part.type === "tool" && part}>{(part) => <ToolIcon part={part()} />}</Match>
                  </Switch>
                  <Switch fallback={<div class="flex-auto min-w-0 text-xs mt-1 text-left">{part.type}</div>}>
                    <Match when={part.type === "text" && part}>
                      {(part) => (
                        <Switch>
                          <Match when={message.role === "user"}>
                            <div class="w-full flex flex-col items-end justify-stretch gap-y-1.5 min-w-0">
                              <p class="w-full rounded-md p-3 ring-1 ring-text/15 ring-inset text-xs bg-background-panel">
                                <span class="font-medium text-text whitespace-pre-wrap break-words">{part().text}</span>
                              </p>
                              <p class="text-xs text-text-muted">12:07pm · adam</p>
                            </div>
                          </Match>
                          <Match when={message.role === "assistant"}>
                            <Markdown text={part().text} class="text-text" />
                          </Match>
                        </Switch>
                      )}
                    </Match>
                    <Match when={part.type === "reasoning" && part}>
                      {(part) => (
                        <CollapsiblePart
                          title={
                            <>
                              <span class="text-text-muted">Thought</span> for {duration(part())}s
                            </>
                          }
                        >
                          <Markdown text={part().text} />
                        </CollapsiblePart>
                      )}
                    </Match>
                    <Match when={part.type === "tool" && part}>{(part) => <ToolPart part={part()} />}</Match>
                  </Switch>
                </li>
              )}
            </For>
          </ul>
        )}
      </For>
    </div>
  )
}
