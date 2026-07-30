import * as Effect from "../../../../Effect.ts"
import * as Encoding from "../../../../Encoding.ts"
import * as Match from "../../../../Match.ts"
import * as Schema from "../../../../Schema.ts"
import * as RpcGroup from "../../../rpc/RpcGroup.ts"
import * as McpSchema from "../../McpSchema.ts"
import type * as McpProtocol from "../mcpProtocol.ts"
import * as DatedMcpSchema from "../mcpSchema/v2025_06_18.ts"
import * as InternalProtocolAdapter from "../protocolAdapter.ts"

const ToolRpcs = RpcGroup.make(
  DatedMcpSchema.ListTools,
  DatedMcpSchema.CallTool
).middleware(McpSchema.McpServerClientMiddleware)

const ResourceRpcs = RpcGroup.make(
  DatedMcpSchema.ListResources,
  DatedMcpSchema.ReadResource,
  DatedMcpSchema.ListResourceTemplates
).middleware(McpSchema.McpServerClientMiddleware)

const ClientHandlerRpcs = ToolRpcs.merge(ResourceRpcs)

const ClientRpcs = McpSchema.ClientRpcs.omit(
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "resources/templates/list"
).merge(ClientHandlerRpcs)

const projectAnnotations = (
  annotations: McpSchema.Annotations | undefined
): typeof DatedMcpSchema.Annotations.Type | undefined =>
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
  return yield* Schema.decodeUnknownEffect(DatedMcpSchema.ToolJsonSchema)(value).pipe(
    Effect.mapError(() =>
      new DatedMcpSchema.InternalError({
        message: `MCP 2025-06-18 cannot represent ${feature}`
      })
    )
  )
})

const projectContent: (
  content: typeof McpSchema.ContentBlock.Type
) => typeof DatedMcpSchema.ContentBlock.Type = Match.type<typeof McpSchema.ContentBlock.Type>().pipe(
  Match.discriminatorsExhaustive("type")({
    text: (content): typeof DatedMcpSchema.ContentBlock.Type => ({
      type: "text",
      text: content.text,
      annotations: projectAnnotations(content.annotations),
      _meta: content._meta
    }),
    image: (content): typeof DatedMcpSchema.ContentBlock.Type => ({
      type: "image",
      data: Encoding.encodeBase64(content.data),
      mimeType: content.mimeType,
      annotations: projectAnnotations(content.annotations),
      _meta: content._meta
    }),
    audio: (content): typeof DatedMcpSchema.ContentBlock.Type => ({
      type: "audio",
      data: Encoding.encodeBase64(content.data),
      mimeType: content.mimeType,
      annotations: projectAnnotations(content.annotations),
      _meta: content._meta
    }),
    resource: (content): typeof DatedMcpSchema.ContentBlock.Type => ({
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
    resource_link: (content): typeof DatedMcpSchema.ContentBlock.Type => ({
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
  McpProtocol.Runtime,
  "2025-06-18",
  RpcGroup.Rpcs<typeof ClientRpcs>,
  RpcGroup.Rpcs<typeof McpSchema.ClientNotificationRpcs>,
  RpcGroup.Rpcs<typeof McpSchema.ServerRequestRpcs>,
  RpcGroup.Rpcs<typeof McpSchema.ServerNotificationRpcs>,
  RpcGroup.Rpcs<typeof ClientHandlerRpcs>
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
  clientHandlerRpcs: ClientHandlerRpcs,
  makeClientHandlers: (runtime: McpProtocol.Runtime) =>
    ClientHandlerRpcs.of({
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
            return DatedMcpSchema.Tool.make({
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
        return DatedMcpSchema.ListToolsResult.make({
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
              ? new DatedMcpSchema.InvalidParams({
                message: error.message,
                data: error.data
              })
              : new DatedMcpSchema.InternalError({
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
          return yield* new DatedMcpSchema.InternalError({
            message: "MCP 2025-06-18 cannot represent non-object structured tool content"
          })
        }
        return DatedMcpSchema.CallToolResult.make({
          content: result.content.map(projectContent),
          structuredContent,
          isError: result.isError,
          _meta: result._meta
        })
      }),
      "resources/list": Effect.fnUntraced(function*() {
        const client = yield* McpSchema.McpServerClient
        return DatedMcpSchema.ListResourcesResult.make({
          resources: runtime.listResources({
            protocolVersion: client.initializePayload.protocolVersion,
            capabilities: client.initializePayload.capabilities,
            clientInfo: client.initializePayload.clientInfo,
            metadata: client.initializePayload._meta
          }).map((resource) =>
            DatedMcpSchema.Resource.make({
              uri: resource.uri,
              name: resource.name,
              title: resource.title,
              description: resource.description,
              mimeType: resource.mimeType,
              annotations: projectAnnotations(resource.annotations),
              size: resource.size,
              _meta: resource._meta
            })
          )
        })
      }),
      "resources/read": Effect.fnUntraced(function*(request) {
        const result = yield* runtime.readResource(request.uri).pipe(
          Effect.mapError((error) =>
            "_tag" in error
              ? error._tag === "InvalidParams"
                ? new DatedMcpSchema.InvalidParams({
                  message: error.message,
                  data: error.data
                })
                : new DatedMcpSchema.InternalError({
                  message: error.message,
                  data: error.data
                })
              : {
                code: error.code,
                message: error.message,
                data: error.data
              }
          )
        )
        return DatedMcpSchema.ReadResourceResult.make({
          contents: result.contents.map((content) =>
            "text" in content
              ? {
                uri: content.uri,
                mimeType: content.mimeType,
                _meta: content._meta,
                text: content.text
              }
              : {
                uri: content.uri,
                mimeType: content.mimeType,
                _meta: content._meta,
                blob: Encoding.encodeBase64(content.blob)
              }
          ),
          _meta: result._meta
        })
      }),
      "resources/templates/list": Effect.fnUntraced(function*() {
        const client = yield* McpSchema.McpServerClient
        return DatedMcpSchema.ListResourceTemplatesResult.make({
          resourceTemplates: runtime.listResourceTemplates({
            protocolVersion: client.initializePayload.protocolVersion,
            capabilities: client.initializePayload.capabilities,
            clientInfo: client.initializePayload.clientInfo,
            metadata: client.initializePayload._meta
          }).map((template) =>
            DatedMcpSchema.ResourceTemplate.make({
              uriTemplate: template.uriTemplate,
              name: template.name,
              title: template.title,
              description: template.description,
              mimeType: template.mimeType,
              annotations: projectAnnotations(template.annotations),
              _meta: template._meta
            })
          )
        })
      })
    })
})
