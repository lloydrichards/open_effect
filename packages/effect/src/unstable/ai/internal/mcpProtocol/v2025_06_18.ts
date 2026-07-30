import * as Effect from "../../../../Effect.ts"
import * as Encoding from "../../../../Encoding.ts"
import * as Match from "../../../../Match.ts"
import * as Schema from "../../../../Schema.ts"
import * as RpcGroup from "../../../rpc/RpcGroup.ts"
import * as McpSchema from "../../McpSchema.ts"
import type * as McpProtocol from "../mcpProtocol.ts"
import * as JuneSchema from "../mcpSchema/v2025_06_18.ts"
import * as InternalProtocolAdapter from "../protocolAdapter.ts"

const ToolRpcs = RpcGroup.make(
  JuneSchema.ListTools,
  JuneSchema.CallTool
).middleware(McpSchema.McpServerClientMiddleware)

const ClientRpcs = McpSchema.ClientRpcs.omit(
  "tools/list",
  "tools/call"
).merge(ToolRpcs)

const projectAnnotations = (
  annotations: McpSchema.Annotations | undefined
): typeof JuneSchema.Annotations.Type | undefined =>
  annotations === undefined
    ? undefined
    : {
      audience: annotations.audience,
      priority: annotations.priority
    }

const projectToolJsonSchema = Effect.fnUntraced(function*(
  value: unknown,
  feature: string
) {
  return yield* Schema.decodeUnknownEffect(JuneSchema.ToolJsonSchema)(value).pipe(
    Effect.mapError(() =>
      new JuneSchema.InternalError({
        message: `MCP 2025-06-18 cannot represent ${feature}`
      })
    )
  )
})

const projectContent: (
  content: typeof McpSchema.ContentBlock.Type
) => typeof JuneSchema.ContentBlock.Type = Match.type<typeof McpSchema.ContentBlock.Type>().pipe(
  Match.discriminatorsExhaustive("type")({
    text: (content): typeof JuneSchema.ContentBlock.Type => ({
      type: "text",
      text: content.text,
      annotations: projectAnnotations(content.annotations),
      _meta: content._meta
    }),
    image: (content): typeof JuneSchema.ContentBlock.Type => ({
      type: "image",
      data: Encoding.encodeBase64(content.data),
      mimeType: content.mimeType,
      annotations: projectAnnotations(content.annotations),
      _meta: content._meta
    }),
    audio: (content): typeof JuneSchema.ContentBlock.Type => ({
      type: "audio",
      data: Encoding.encodeBase64(content.data),
      mimeType: content.mimeType,
      annotations: projectAnnotations(content.annotations),
      _meta: content._meta
    }),
    resource: (content): typeof JuneSchema.ContentBlock.Type => ({
      type: "resource",
      resource: "text" in content.resource
        ? {
          uri: content.resource.uri,
          mimeType: content.resource.mimeType,
          _meta: content.resource._meta,
          text: content.resource.text
        }
        : {
          uri: content.resource.uri,
          mimeType: content.resource.mimeType,
          _meta: content.resource._meta,
          blob: Encoding.encodeBase64(content.resource.blob)
        },
      annotations: projectAnnotations(content.annotations),
      _meta: content._meta
    }),
    resource_link: (content): typeof JuneSchema.ContentBlock.Type => ({
      type: "resource_link",
      uri: content.uri,
      name: content.name,
      title: content.title,
      description: content.description,
      mimeType: content.mimeType,
      annotations: projectAnnotations(content.annotations),
      size: content.size,
      _meta: content._meta
    })
  })
)

export type ProtocolAdapter = InternalProtocolAdapter.ProtocolAdapter<
  McpProtocol.ToolRuntime,
  "2025-06-18",
  RpcGroup.Rpcs<typeof ClientRpcs>,
  RpcGroup.Rpcs<typeof McpSchema.ClientNotificationRpcs>,
  RpcGroup.Rpcs<typeof McpSchema.ServerRequestRpcs>,
  RpcGroup.Rpcs<typeof McpSchema.ServerNotificationRpcs>,
  RpcGroup.Rpcs<typeof ToolRpcs>
>

export const v2025_06_18: ProtocolAdapter = InternalProtocolAdapter.make({
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
  makeClientHandlers: (runtime: McpProtocol.ToolRuntime) =>
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
              annotations: tool.annotations === undefined
                ? undefined
                : {
                  title: tool.annotations.title,
                  readOnlyHint: tool.annotations.readOnlyHint,
                  destructiveHint: tool.annotations.destructiveHint,
                  idempotentHint: tool.annotations.idempotentHint,
                  openWorldHint: tool.annotations.openWorldHint
                },
              _meta: tool._meta
            })
          })
        )
        return JuneSchema.ListToolsResult.make({
          tools
        })
      }),
      "tools/call": Effect.fnUntraced(function*(request) {
        const result = yield* runtime.call({
          name: request.name,
          arguments: request.arguments ?? {},
          _meta: request._meta
        }).pipe(
          Effect.mapError((error) =>
            error._tag === "InvalidParams"
              ? new JuneSchema.InvalidParams({
                message: error.message,
                data: error.data
              })
              : new JuneSchema.InternalError({
                message: error.message,
                data: error.data
              })
          )
        )
        const structuredContent = result.structuredContent
        if (
          structuredContent !== undefined &&
          !Schema.is(Schema.Record(Schema.String, Schema.Json))(structuredContent)
        ) {
          return yield* new JuneSchema.InternalError({
            message: "MCP 2025-06-18 cannot represent non-object structured tool content"
          })
        }
        return JuneSchema.CallToolResult.make({
          content: result.content.map(projectContent),
          structuredContent,
          isError: result.isError,
          _meta: result._meta
        })
      })
    })
})
