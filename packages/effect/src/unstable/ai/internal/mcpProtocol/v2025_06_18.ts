/**
 * Protocol adapter for MCP revision 2025-06-18.
 *
 * Selects the dated schemas for client and server traffic and maps their wire
 * representations to the canonical MCP runtime.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18
 * @internal
 */
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

const PromptRpcs = RpcGroup.make(
  DatedMcpSchema.ListPrompts,
  DatedMcpSchema.GetPrompt
).middleware(McpSchema.McpServerClientMiddleware)

const CompletionRpcs = RpcGroup.make(
  DatedMcpSchema.Complete
).middleware(McpSchema.McpServerClientMiddleware)

const LifecycleRpcs = RpcGroup.make(
  DatedMcpSchema.Ping,
  DatedMcpSchema.Initialize,
  DatedMcpSchema.SetLevel,
  DatedMcpSchema.Subscribe,
  DatedMcpSchema.Unsubscribe
).middleware(McpSchema.McpServerClientMiddleware)

const ClientNotificationRpcs = RpcGroup.make(
  DatedMcpSchema.CancelledNotification,
  DatedMcpSchema.ProgressNotification,
  DatedMcpSchema.InitializedNotification,
  DatedMcpSchema.RootsListChangedNotification
)

const ClientHandlerRpcs = LifecycleRpcs
  .merge(ToolRpcs)
  .merge(ResourceRpcs)
  .merge(PromptRpcs)
  .merge(CompletionRpcs)
  .merge(ClientNotificationRpcs)

const ClientRpcs = ClientHandlerRpcs

const ServerNotificationRpcs = RpcGroup.make(
  DatedMcpSchema.CancelledNotification,
  DatedMcpSchema.ProgressNotification,
  DatedMcpSchema.LoggingMessageNotification,
  DatedMcpSchema.ResourceUpdatedNotification,
  DatedMcpSchema.ResourceListChangedNotification,
  DatedMcpSchema.ToolListChangedNotification,
  DatedMcpSchema.PromptListChangedNotification
)

const ServerRequestRpcs = McpSchema.ServerRequestRpcs.omit(
  "ping",
  "roots/list",
  "sampling/createMessage",
  "elicitation/create"
).merge(RpcGroup.make(
  DatedMcpSchema.Ping,
  DatedMcpSchema.ListRoots,
  DatedMcpSchema.CreateMessage,
  DatedMcpSchema.Elicit
))

const projectAnnotations = (
  annotations: McpSchema.Annotations | undefined
): typeof DatedMcpSchema.Annotations.Type | undefined =>
  annotations === undefined
    ? undefined
    : {
      audience: annotations.audience,
      priority: annotations.priority,
      lastModified: annotations.lastModified
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

/** @internal */
export type ProtocolAdapter = InternalProtocolAdapter.ProtocolAdapter<
  McpProtocol.Runtime,
  "2025-06-18",
  RpcGroup.Rpcs<typeof ClientRpcs>,
  RpcGroup.Rpcs<typeof ClientNotificationRpcs>,
  RpcGroup.Rpcs<typeof ServerRequestRpcs>,
  RpcGroup.Rpcs<typeof ServerNotificationRpcs>,
  RpcGroup.Rpcs<typeof ClientHandlerRpcs>
>

/** @internal */
export const v2025_06_18: ProtocolAdapter = InternalProtocolAdapter.make({
  protocolVersion: "2025-06-18",
  transport: {
    acceptsJsonRpcBatches: false,
    requiresVersionHeader: true
  },
  clientRpcs: ClientRpcs,
  clientNotificationRpcs: ClientNotificationRpcs,
  serverRequestRpcs: ServerRequestRpcs,
  serverNotificationRpcs: ServerNotificationRpcs,
  clientHandlerRpcs: ClientHandlerRpcs,
  makeClientHandlers: (runtime: McpProtocol.Runtime) =>
    ClientHandlerRpcs.of({
      ping: () => Effect.succeed({}),
      initialize: Effect.fnUntraced(function*(request, { client }) {
        const extensions = request.capabilities.extensions
        const result = yield* runtime.initialize({
          protocolVersion: request.protocolVersion,
          capabilities: new McpSchema.ClientCapabilities({
            experimental: request.capabilities.experimental,
            extensions: extensions !== undefined && Object.keys(extensions).every((key) => key.includes("/"))
              ? extensions
              : undefined,
            roots: request.capabilities.roots,
            sampling: request.capabilities.sampling,
            elicitation: request.capabilities.elicitation
          }),
          clientInfo: {
            name: request.clientInfo.name,
            title: request.clientInfo.title,
            version: request.clientInfo.version
          },
          _meta: request._meta
        }, client.id as number)
        return DatedMcpSchema.InitializeResult.make({
          protocolVersion: "2025-06-18",
          capabilities: {
            experimental: result.capabilities.experimental,
            extensions: result.capabilities.extensions,
            logging: result.capabilities.logging,
            completions: result.capabilities.completions,
            prompts: result.capabilities.prompts,
            resources: result.capabilities.resources,
            tools: result.capabilities.tools
          },
          serverInfo: {
            name: result.serverInfo.name,
            title: result.serverInfo.title,
            version: result.serverInfo.version
          },
          instructions: result.instructions,
          _meta: result._meta
        })
      }),
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
      }),
      "prompts/list": Effect.fnUntraced(function*() {
        const client = yield* McpSchema.McpServerClient
        return DatedMcpSchema.ListPromptsResult.make({
          prompts: runtime.listPrompts({
            protocolVersion: client.initializePayload.protocolVersion,
            capabilities: client.initializePayload.capabilities,
            clientInfo: client.initializePayload.clientInfo,
            metadata: client.initializePayload._meta
          }).map((prompt) =>
            DatedMcpSchema.Prompt.make({
              name: prompt.name,
              title: prompt.title,
              description: prompt.description,
              arguments: prompt.arguments?.map((argument) =>
                DatedMcpSchema.PromptArgument.make({
                  name: argument.name,
                  title: argument.title,
                  description: argument.description,
                  required: argument.required
                })
              )
            })
          )
        })
      }),
      "prompts/get": Effect.fnUntraced(function*(request) {
        const result = yield* runtime.getPrompt({
          name: request.name,
          arguments: request.arguments,
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
        return DatedMcpSchema.GetPromptResult.make({
          description: result.description,
          messages: result.messages.map((message) => ({
            role: message.role,
            content: projectContent(message.content)
          })),
          _meta: result._meta
        })
      }),
      "completion/complete": Effect.fnUntraced(function*(request) {
        const result = yield* runtime.complete({
          ref: request.ref.type === "ref/prompt"
            ? {
              type: "ref/prompt",
              name: request.ref.name,
              title: request.ref.title
            }
            : {
              type: "ref/resource",
              uri: request.ref.uri
            },
          argument: {
            name: request.argument.name,
            value: request.argument.value
          },
          context: {
            arguments: request.context?.arguments ?? {}
          },
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
        return DatedMcpSchema.CompleteResult.make({
          completion: {
            values: result.completion.values,
            total: result.completion.total,
            hasMore: result.completion.hasMore
          },
          _meta: result._meta
        })
      }),
      "logging/setLevel": Effect.fnUntraced(function*(request, { client, headers }) {
        yield* runtime.setLogLevel(request.level, client.id as number, headers)
        return {}
      }),
      "resources/subscribe": Effect.fnUntraced(function*(request, { client, headers }) {
        yield* runtime.subscribe(request.uri, client.id as number, headers).pipe(
          Effect.mapError((error) =>
            new DatedMcpSchema.MethodNotFound({
              message: error.message,
              data: error.data
            })
          )
        )
        return {}
      }),
      "resources/unsubscribe": Effect.fnUntraced(function*(request, { client, headers }) {
        yield* runtime.unsubscribe(request.uri, client.id as number, headers).pipe(
          Effect.mapError((error) =>
            new DatedMcpSchema.MethodNotFound({
              message: error.message,
              data: error.data
            })
          )
        )
        return {}
      }),
      "notifications/cancelled": () => Effect.void,
      "notifications/progress": () => Effect.void,
      "notifications/initialized": (_, { client, headers }) => runtime.initialized(client.id as number, headers),
      "notifications/roots/list_changed": () => Effect.void
    })
})
