import type * as Effect from "../../../Effect.ts"
import type * as Headers from "../../http/Headers.ts"
import type * as McpSchema from "../McpSchema.ts"
import type * as McpCore from "./mcpCore.ts"

/** @internal */
export interface ToolRuntime {
  readonly list: (
    profile: McpCore.ClientProfile | undefined
  ) => ReadonlyArray<McpSchema.Tool>
  readonly call: (
    request: typeof McpSchema.CallTool.payloadSchema.Type
  ) => Effect.Effect<
    McpSchema.CallToolResult,
    McpSchema.InternalError | McpSchema.InvalidParams,
    McpSchema.McpServerClient
  >
}

/** @internal */
export interface ResourceRuntime {
  readonly listResources: (
    profile: McpCore.ClientProfile | undefined
  ) => ReadonlyArray<McpSchema.Resource>
  readonly listResourceTemplates: (
    profile: McpCore.ClientProfile | undefined
  ) => ReadonlyArray<McpSchema.ResourceTemplate>
  readonly readResource: (
    uri: string
  ) => Effect.Effect<
    typeof McpSchema.ReadResourceResult.Type,
    McpSchema.McpErrorBase | McpSchema.InvalidParams | McpSchema.InternalError,
    McpSchema.McpServerClient
  >
}

/** @internal */
export interface PromptRuntime {
  readonly listPrompts: (
    profile: McpCore.ClientProfile | undefined
  ) => ReadonlyArray<McpSchema.Prompt>
  readonly getPrompt: (
    request: typeof McpSchema.GetPrompt.payloadSchema.Type
  ) => Effect.Effect<
    McpSchema.GetPromptResult,
    McpSchema.InvalidParams | McpSchema.InternalError,
    McpSchema.McpServerClient
  >
}

/** @internal */
export interface CompletionRuntime {
  readonly complete: (
    request: typeof McpSchema.Complete.payloadSchema.Type
  ) => Effect.Effect<
    McpSchema.CompleteResult,
    McpSchema.InvalidParams | McpSchema.InternalError,
    McpSchema.McpServerClient
  >
}

/** @internal */
export interface LifecycleRuntime {
  readonly initialize: (
    request: typeof McpSchema.Initialize.payloadSchema.Type,
    clientId: number
  ) => Effect.Effect<McpSchema.InitializeResult>
  readonly setLogLevel: (
    level: typeof McpSchema.LoggingLevel.Type,
    clientId: number,
    headers: Headers.Headers
  ) => Effect.Effect<void>
  readonly subscribe: (
    uri: string,
    clientId: number,
    headers: Headers.Headers
  ) => Effect.Effect<void, McpSchema.MethodNotFound>
  readonly unsubscribe: (
    uri: string,
    clientId: number,
    headers: Headers.Headers
  ) => Effect.Effect<void, McpSchema.MethodNotFound>
  readonly initialized: (
    clientId: number,
    headers: Headers.Headers
  ) => Effect.Effect<void>
}

/** @internal */
export interface Runtime extends ToolRuntime, ResourceRuntime, PromptRuntime, CompletionRuntime, LifecycleRuntime {}
