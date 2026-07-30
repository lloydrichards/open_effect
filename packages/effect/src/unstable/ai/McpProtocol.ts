/**
 * Defines the MCP protocol implementations that an `McpServer` can support.
 *
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Encoding from "../../Encoding.ts"
import * as Schema from "../../Schema.ts"
import * as RpcGroup from "../rpc/RpcGroup.ts"
import * as Internal from "./internal/mcpProtocol.ts"
import * as JuneSchema from "./internal/mcpSchema/v2025_06_18.ts"
import * as McpSchema from "./McpSchema.ts"

const ToolRpcs = RpcGroup.make(
  JuneSchema.ListTools,
  JuneSchema.CallTool
).middleware(McpSchema.McpServerClientMiddleware)

const ClientRpcs = McpSchema.ClientRpcs.omit(
  "tools/list",
  "tools/call"
).merge(ToolRpcs)

class ToolWireProjectionError extends Data.TaggedError("ToolWireProjectionError")<{
  readonly feature: string
}> {}

const projectionError = (feature: string) => new ToolWireProjectionError({ feature })

const projectAnnotations = (
  annotations: McpSchema.Annotations | undefined
): typeof JuneSchema.Annotations.Type | undefined =>
  annotations === undefined
    ? undefined
    : {
      audience: annotations.audience,
      priority: annotations.priority
    }

const projectToolAnnotations = (
  annotations: McpSchema.ToolAnnotations | undefined
): typeof JuneSchema.ToolAnnotations.Type | undefined =>
  annotations === undefined
    ? undefined
    : {
      title: annotations.title,
      readOnlyHint: annotations.readOnlyHint,
      destructiveHint: annotations.destructiveHint,
      idempotentHint: annotations.idempotentHint,
      openWorldHint: annotations.openWorldHint
    }

const projectToolJsonSchema = Effect.fnUntraced(function*(
  value: unknown,
  feature: string
) {
  return yield* Schema.decodeUnknownEffect(JuneSchema.ToolJsonSchema)(value).pipe(
    Effect.mapError(() => projectionError(feature))
  )
})

const projectResourceContents = (
  resource: McpSchema.TextResourceContents | McpSchema.BlobResourceContents
): typeof JuneSchema.ResourceContents.Type =>
  "text" in resource
    ? {
      uri: resource.uri,
      mimeType: resource.mimeType,
      _meta: resource._meta,
      text: resource.text
    }
    : {
      uri: resource.uri,
      mimeType: resource.mimeType,
      _meta: resource._meta,
      blob: Encoding.encodeBase64(resource.blob)
    }

const projectContent = (
  content: typeof McpSchema.ContentBlock.Type
): typeof JuneSchema.ContentBlock.Type => {
  switch (content.type) {
    case "text": {
      return {
        type: "text",
        text: content.text,
        annotations: projectAnnotations(content.annotations),
        _meta: content._meta
      }
    }
    case "image":
    case "audio": {
      return {
        type: content.type,
        data: Encoding.encodeBase64(content.data),
        mimeType: content.mimeType,
        annotations: projectAnnotations(content.annotations),
        _meta: content._meta
      }
    }
    case "resource": {
      return {
        type: "resource",
        resource: projectResourceContents(content.resource),
        annotations: projectAnnotations(content.annotations),
        _meta: content._meta
      }
    }
    case "resource_link": {
      return {
        type: "resource_link",
        uri: content.uri,
        name: content.name,
        title: content.title,
        description: content.description,
        mimeType: content.mimeType,
        annotations: projectAnnotations(content.annotations),
        size: content.size,
        _meta: content._meta
      }
    }
  }
}

const projectStructuredContent = (
  content: unknown
): Effect.Effect<Schema.JsonObject | undefined, ToolWireProjectionError> => {
  if (content === undefined) {
    return Effect.succeed(undefined)
  }
  if (Schema.is(Schema.Record(Schema.String, Schema.Json))(content)) {
    return Effect.succeed(content)
  }
  return Effect.fail(projectionError("non-object structured tool content"))
}

const mapProjectionError = (
  error: ToolWireProjectionError
): JuneSchema.InternalError =>
  new JuneSchema.InternalError({
    message: `MCP 2025-06-18 cannot represent ${error.feature}`
  })

const mapRuntimeError = (
  error: McpSchema.InternalError | McpSchema.InvalidParams
): JuneSchema.InternalError | JuneSchema.InvalidParams =>
  error._tag === "InvalidParams"
    ? new JuneSchema.InvalidParams({
      message: error.message,
      data: error.data
    })
    : new JuneSchema.InternalError({
      message: error.message,
      data: error.data
    })
/**
 * The MCP 2025-06-18 protocol implementation.
 *
 * @category protocols
 * @since 4.0.0
 */
export const v2025_06_18: ProtocolAdapter = Internal.make({
  protocolVersion: "2025-06-18",
  transport: {
    acceptsJsonRpcBatches: false,
    requiresVersionHeader: true
  },
  clientRpcs: ClientRpcs,
  clientNotificationRpcs: McpSchema.ClientNotificationRpcs,
  serverRequestRpcs: McpSchema.ServerRequestRpcs,
  serverNotificationRpcs: McpSchema.ServerNotificationRpcs,
  clientHandlerRpcs: ToolRpcs,
  makeClientHandlers: (runtime) =>
    ToolRpcs.of({
      "tools/list": Effect.fnUntraced(function*() {
        const client = yield* McpSchema.McpServerClient
        const tools = yield* Effect.forEach(
          runtime.list({
            protocolVersion: client.protocolVersion,
            capabilities: client.initializePayload.capabilities,
            clientInfo: client.initializePayload.clientInfo,
            metadata: client.initializePayload._meta
          }),
          Effect.fnUntraced(function*(tool) {
            const inputSchema = yield* projectToolJsonSchema(
              tool.inputSchema,
              `input schema for tool ${tool.name}`
            )
            const outputSchema = tool.outputSchema === undefined
              ? undefined
              : yield* projectToolJsonSchema(
                tool.outputSchema,
                `output schema for tool ${tool.name}`
              )
            return JuneSchema.Tool.make({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema,
              outputSchema,
              annotations: projectToolAnnotations(tool.annotations),
              _meta: tool._meta
            })
          })
        ).pipe(Effect.mapError(mapProjectionError))
        return JuneSchema.ListToolsResult.make({
          tools
        })
      }),
      "tools/call": Effect.fnUntraced(function*(request) {
        const result = yield* runtime.call({
          name: request.name,
          arguments: request.arguments ?? {},
          _meta: request._meta
        }).pipe(Effect.mapError(mapRuntimeError))
        const structuredContent = yield* projectStructuredContent(result.structuredContent).pipe(
          Effect.mapError(mapProjectionError)
        )
        return JuneSchema.CallToolResult.make({
          content: result.content.map(projectContent),
          structuredContent,
          isError: result.isError,
          _meta: result._meta
        })
      })
    })
})

/**
 * An implemented MCP protocol that can be supplied to `McpServer`.
 *
 * @category models
 * @since 4.0.0
 */
export type ProtocolAdapter = Internal.ProtocolAdapter<
  "2025-06-18",
  RpcGroup.Rpcs<typeof ClientRpcs>,
  RpcGroup.Rpcs<typeof McpSchema.ClientNotificationRpcs>,
  RpcGroup.Rpcs<typeof McpSchema.ServerRequestRpcs>,
  RpcGroup.Rpcs<typeof McpSchema.ServerNotificationRpcs>
>

/**
 * The MCP protocol versions implemented by this release.
 *
 * @category models
 * @since 4.0.0
 */
export type ProtocolVersion = ProtocolAdapter["protocolVersion"]
