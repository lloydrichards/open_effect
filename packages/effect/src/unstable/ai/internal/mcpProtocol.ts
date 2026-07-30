import type * as Effect from "../../../Effect.ts"
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
export interface Runtime extends ToolRuntime, ResourceRuntime {}
