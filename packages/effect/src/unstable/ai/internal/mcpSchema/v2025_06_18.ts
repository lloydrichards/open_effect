/**
 * Exact wire schemas for MCP revision 2025-06-18.
 *
 * These schemas remain independent from the canonical `McpSchema` model so
 * each protocol revision can validate and encode its own wire contract.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18
 * @see https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.ts
 * @internal
 */
import * as Effect from "../../../../Effect.ts"
import * as Option from "../../../../Option.ts"
import * as Schema from "../../../../Schema.ts"
import * as SchemaGetter from "../../../../SchemaGetter.ts"
import * as Rpc from "../../../rpc/Rpc.ts"

export const protocolVersion = "2025-06-18"

const optional = <S extends Schema.Constraint>(
  schema: S
): Schema.decodeTo<Schema.optional<S>, Schema.optionalKey<S>> =>
  Schema.optionalKey(schema).pipe(
    Schema.decodeTo(Schema.optional(schema), {
      decode: SchemaGetter.passthrough() as any,
      encode: SchemaGetter.transformOptional(Option.flatMap(Option.fromUndefinedOr))
    })
  )

export const JsonObject = Schema.Record(Schema.String, Schema.Json)

export const ProgressToken = Schema.Union([Schema.String, Schema.Finite])

export const RequestMetaValue = Schema.StructWithRest(
  Schema.Struct({
    progressToken: Schema.optionalKey(ProgressToken)
  }),
  [JsonObject]
)

export const RequestMeta = Schema.Struct({
  _meta: optional(RequestMetaValue)
})

export const ResultMeta = Schema.Struct({
  _meta: optional(JsonObject)
})

const requestParams = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(
    Schema.Struct({
      ...RequestMeta.fields,
      ...fields
    }),
    [JsonObject]
  )

// FIX: StructWithRest applies its rest schema to known fields too, requiring
// permissive rests that also admit non-JSON or undefined extension values.
// Support validating only unknown keys, then tighten these wire extensions
// without rejecting transformed or explicitly undefined known fields.
const result = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(
    Schema.Struct({
      ...ResultMeta.fields,
      ...fields
    }),
    [Schema.Record(Schema.String, Schema.Any)]
  )

const capabilities = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(
    Schema.Struct(fields),
    [Schema.Record(Schema.String, Schema.UndefinedOr(JsonObject))]
  )

export const RequestParams = requestParams({})

const NotificationMetaFields = {
  _meta: optional(JsonObject)
}

const notificationParams = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(
    Schema.Struct({
      ...NotificationMetaFields,
      ...fields
    }),
    [JsonObject]
  )

export const NotificationMeta = notificationParams({})

export const Implementation = Schema.Struct({
  name: Schema.String,
  title: optional(Schema.String),
  version: Schema.String
})

export const ClientCapabilities = capabilities({
  experimental: optional(Schema.Record(Schema.String, JsonObject)),
  extensions: optional(JsonObject),
  roots: optional(Schema.Struct({
    listChanged: optional(Schema.Boolean)
  })),
  sampling: optional(JsonObject),
  elicitation: optional(JsonObject)
})

export const ServerCapabilities = capabilities({
  experimental: optional(Schema.Record(Schema.String, JsonObject)),
  extensions: optional(JsonObject),
  logging: optional(JsonObject),
  completions: optional(JsonObject),
  prompts: optional(Schema.Struct({
    listChanged: optional(Schema.Boolean)
  })),
  resources: optional(Schema.Struct({
    subscribe: optional(Schema.Boolean),
    listChanged: optional(Schema.Boolean)
  })),
  tools: optional(Schema.Struct({
    listChanged: optional(Schema.Boolean)
  }))
})

export const EmptyResult = result({})

export const InitializeResult = result({
  protocolVersion: Schema.String,
  capabilities: ServerCapabilities,
  serverInfo: Implementation,
  instructions: optional(Schema.String)
})

export const LoggingLevel = Schema.Literals([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency"
])

export const RequestId = Schema.Union([Schema.String, Schema.Finite])

const PaginatedRequestFields = {
  cursor: optional(Schema.String)
}

const PaginatedResultFields = {
  nextCursor: optional(Schema.String)
}

export const PaginatedRequest = requestParams(PaginatedRequestFields)

export const PaginatedResult = result(PaginatedResultFields)

export const McpErrorBase = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: optional(Schema.Any)
})

export const INVALID_REQUEST_ERROR_CODE = -32600 as const
export const METHOD_NOT_FOUND_ERROR_CODE = -32601 as const
export const INVALID_PARAMS_ERROR_CODE = -32602 as const
export const INTERNAL_ERROR_CODE = -32603 as const
export const PARSE_ERROR_CODE = -32700 as const

export class ParseError extends Schema.ErrorClass<ParseError>(
  "effect/ai/internal/mcpSchema/2025-06-18/ParseError"
)({
  ...McpErrorBase.fields,
  _tag: Schema.tagDefaultOmit("ParseError"),
  code: Schema.tag(PARSE_ERROR_CODE)
}) {}

export class InvalidRequest extends Schema.ErrorClass<InvalidRequest>(
  "effect/ai/internal/mcpSchema/2025-06-18/InvalidRequest"
)({
  ...McpErrorBase.fields,
  _tag: Schema.tagDefaultOmit("InvalidRequest"),
  code: Schema.tag(INVALID_REQUEST_ERROR_CODE)
}) {}

export class MethodNotFound extends Schema.ErrorClass<MethodNotFound>(
  "effect/ai/internal/mcpSchema/2025-06-18/MethodNotFound"
)({
  ...McpErrorBase.fields,
  _tag: Schema.tagDefaultOmit("MethodNotFound"),
  code: Schema.tag(METHOD_NOT_FOUND_ERROR_CODE)
}) {}

export class InvalidParams extends Schema.ErrorClass<InvalidParams>(
  "effect/ai/internal/mcpSchema/2025-06-18/InvalidParams"
)({
  ...McpErrorBase.fields,
  _tag: Schema.tagDefaultOmit("InvalidParams"),
  code: Schema.tag(INVALID_PARAMS_ERROR_CODE)
}) {}

export class InternalError extends Schema.ErrorClass<InternalError>(
  "effect/ai/internal/mcpSchema/2025-06-18/InternalError"
)({
  ...McpErrorBase.fields,
  _tag: Schema.tagDefaultOmit("InternalError"),
  code: Schema.tag(INTERNAL_ERROR_CODE)
}) {
  static readonly notImplemented = new InternalError({ message: "Not implemented" })
}

export const McpError = Schema.Union([
  ParseError,
  InvalidRequest,
  MethodNotFound,
  InvalidParams,
  InternalError,
  McpErrorBase
])

export class Initialize extends Rpc.make("initialize", {
  success: InitializeResult,
  error: McpError,
  payload: requestParams({
    protocolVersion: Schema.String,
    capabilities: ClientCapabilities,
    clientInfo: Implementation
  })
}) {}

export class Ping extends Rpc.make("ping", {
  success: EmptyResult,
  error: McpError,
  payload: Schema.UndefinedOr(RequestParams)
}) {}

export class SetLevel extends Rpc.make("logging/setLevel", {
  success: EmptyResult,
  error: McpError,
  payload: requestParams({
    level: LoggingLevel
  })
}) {}

export class Subscribe extends Rpc.make("resources/subscribe", {
  success: EmptyResult,
  error: McpError,
  payload: requestParams({
    uri: Schema.String
  })
}) {}

export class Unsubscribe extends Rpc.make("resources/unsubscribe", {
  success: EmptyResult,
  error: McpError,
  payload: requestParams({
    uri: Schema.String
  })
}) {}

export const Root = Schema.Struct({
  uri: Schema.String,
  name: optional(Schema.String),
  _meta: optional(JsonObject)
})

export const ListRootsResult = Schema.StructWithRest(
  Schema.Struct({
    ...ResultMeta.fields,
    roots: Schema.Array(Root)
  }),
  [JsonObject]
)

export class ListRoots extends Rpc.make("roots/list", {
  success: ListRootsResult,
  error: McpError,
  payload: Schema.UndefinedOr(RequestParams)
}) {}

export class CancelledNotification extends Rpc.make("notifications/cancelled", {
  payload: notificationParams({
    requestId: RequestId,
    reason: optional(Schema.String)
  })
}) {}

export class ProgressNotification extends Rpc.make("notifications/progress", {
  payload: notificationParams({
    progressToken: ProgressToken,
    progress: Schema.Finite,
    total: optional(Schema.Finite),
    message: optional(Schema.String)
  })
}) {}

export class InitializedNotification extends Rpc.make("notifications/initialized", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

export class RootsListChangedNotification extends Rpc.make("notifications/roots/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

export class LoggingMessageNotification extends Rpc.make("notifications/message", {
  payload: notificationParams({
    level: LoggingLevel,
    logger: optional(Schema.String),
    data: Schema.Json
  })
}) {}

export class ResourceUpdatedNotification extends Rpc.make("notifications/resources/updated", {
  payload: notificationParams({
    uri: Schema.String
  })
}) {}

export class ResourceListChangedNotification extends Rpc.make("notifications/resources/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

export class ToolListChangedNotification extends Rpc.make("notifications/tools/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

export class PromptListChangedNotification extends Rpc.make("notifications/prompts/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

export const Role = Schema.Literals(["user", "assistant"])

export const Annotations = Schema.Struct({
  audience: optional(Schema.Array(Role)),
  priority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  lastModified: optional(Schema.String)
})

export const Resource = Schema.Struct({
  uri: Schema.String,
  name: Schema.String,
  title: optional(Schema.String),
  description: optional(Schema.String),
  mimeType: optional(Schema.String),
  annotations: optional(Annotations),
  size: optional(Schema.Finite),
  _meta: optional(JsonObject)
})

export const ResourceTemplate = Schema.Struct({
  uriTemplate: Schema.String,
  name: Schema.String,
  title: optional(Schema.String),
  description: optional(Schema.String),
  mimeType: optional(Schema.String),
  annotations: optional(Annotations),
  _meta: optional(JsonObject)
})

const ResourceContentsBase = Schema.Struct({
  uri: Schema.String,
  mimeType: optional(Schema.String),
  _meta: optional(JsonObject)
})

export const TextResourceContents = Schema.Struct({
  ...ResourceContentsBase.fields,
  text: Schema.String
})

export const BlobResourceContents = Schema.Struct({
  ...ResourceContentsBase.fields,
  blob: Schema.String.check(Schema.isBase64())
})

export const ResourceContents = Schema.Union([TextResourceContents, BlobResourceContents])

export const ListResourcesResult = result({
  ...PaginatedResultFields,
  resources: Schema.Array(Resource)
})

export const ListResourceTemplatesResult = result({
  ...PaginatedResultFields,
  resourceTemplates: Schema.Array(ResourceTemplate)
})

export const ReadResourceResult = result({
  contents: Schema.Array(ResourceContents)
})

export class ListResources extends Rpc.make("resources/list", {
  success: ListResourcesResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequest)
}) {}

export class ListResourceTemplates extends Rpc.make("resources/templates/list", {
  success: ListResourceTemplatesResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequest)
}) {}

export class ReadResource extends Rpc.make("resources/read", {
  success: ReadResourceResult,
  error: McpError,
  payload: requestParams({
    uri: Schema.String
  })
}) {}

export const EmbeddedResource = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: ResourceContents,
  annotations: optional(Annotations),
  _meta: optional(JsonObject)
})

export const ResourceLink = Schema.Struct({
  ...Resource.fields,
  type: Schema.Literal("resource_link")
})

export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  annotations: optional(Annotations),
  _meta: optional(JsonObject)
})

export const ImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String.check(Schema.isBase64()),
  mimeType: Schema.String,
  annotations: optional(Annotations),
  _meta: optional(JsonObject)
})

export const AudioContent = Schema.Struct({
  type: Schema.Literal("audio"),
  data: Schema.String.check(Schema.isBase64()),
  mimeType: Schema.String,
  annotations: optional(Annotations),
  _meta: optional(JsonObject)
})

export const ContentBlock = Schema.Union([
  TextContent,
  ImageContent,
  AudioContent,
  EmbeddedResource,
  ResourceLink
])

export const SamplingAnnotations = Schema.Struct({
  audience: optional(Schema.Array(Role)),
  priority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  lastModified: optional(Schema.String)
})

export const SamplingTextContent = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
  annotations: optional(SamplingAnnotations),
  _meta: optional(JsonObject)
})

export const SamplingImageContent = Schema.Struct({
  type: Schema.tag("image"),
  data: Schema.Uint8ArrayFromBase64,
  mimeType: Schema.String,
  annotations: optional(SamplingAnnotations),
  _meta: optional(JsonObject)
})

export const SamplingAudioContent = Schema.Struct({
  type: Schema.tag("audio"),
  data: Schema.Uint8ArrayFromBase64,
  mimeType: Schema.String,
  annotations: optional(SamplingAnnotations),
  _meta: optional(JsonObject)
})

export const SamplingContent = Schema.Union([
  SamplingTextContent,
  SamplingImageContent,
  SamplingAudioContent
])

const SamplingContentWire = Schema.toEncoded(SamplingContent)

export const SamplingMessage = Schema.Struct({
  role: Role,
  content: SamplingContent
})

export const ModelHint = Schema.StructWithRest(
  Schema.Struct({
    name: optional(Schema.String)
  }),
  [JsonObject]
)

export const ModelPreferences = Schema.Struct({
  hints: optional(Schema.Array(ModelHint)),
  costPriority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  speedPriority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  intelligencePriority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
})

const CreateMessageResultWire = Schema.StructWithRest(
  Schema.Struct({
    ...ResultMeta.fields,
    role: Role,
    content: SamplingContentWire,
    model: Schema.String,
    stopReason: optional(Schema.String)
  }),
  [JsonObject]
)

const CreateMessageResultConversion = Schema.StructWithRest(
  Schema.Struct({
    ...ResultMeta.fields,
    role: Role,
    content: SamplingContent,
    model: Schema.String,
    stopReason: optional(Schema.String)
  }),
  [Schema.Record(Schema.String, Schema.Any)]
)

const CreateMessageResultType = Schema.toType(CreateMessageResultConversion)

export const CreateMessageResult = CreateMessageResultWire.pipe(
  Schema.decodeTo(CreateMessageResultType, {
    decode: SchemaGetter.transformOrFail((input, options) =>
      Schema.decodeUnknownEffect(CreateMessageResultConversion)(input, options).pipe(
        Effect.mapError((error) => error.issue)
      )
    ),
    encode: SchemaGetter.transformOrFail((input, options) =>
      Schema.encodeEffect(CreateMessageResultConversion)(input, options).pipe(
        Effect.mapError((error) => error.issue)
      )
    )
  })
)

const CreateMessagePayloadWire = Schema.StructWithRest(
  Schema.Struct({
    ...RequestMeta.fields,
    messages: Schema.Array(Schema.Struct({
      role: Role,
      content: SamplingContentWire
    })),
    modelPreferences: optional(ModelPreferences),
    systemPrompt: optional(Schema.String),
    includeContext: optional(Schema.Literals(["none", "thisServer", "allServers"])),
    temperature: optional(Schema.Finite),
    maxTokens: Schema.Finite,
    stopSequences: optional(Schema.Array(Schema.String)),
    metadata: optional(JsonObject)
  }),
  [JsonObject]
)

const CreateMessagePayloadConversion = Schema.StructWithRest(
  Schema.Struct({
    ...RequestMeta.fields,
    messages: Schema.Array(SamplingMessage),
    modelPreferences: optional(ModelPreferences),
    systemPrompt: optional(Schema.String),
    includeContext: optional(Schema.Literals(["none", "thisServer", "allServers"])),
    temperature: optional(Schema.Finite),
    maxTokens: Schema.Finite,
    stopSequences: optional(Schema.Array(Schema.String)),
    metadata: optional(JsonObject)
  }),
  [Schema.Record(Schema.String, Schema.Any)]
)

const CreateMessagePayloadType = Schema.toType(CreateMessagePayloadConversion)

export const CreateMessagePayload = CreateMessagePayloadWire.pipe(
  Schema.decodeTo(CreateMessagePayloadType, {
    decode: SchemaGetter.transformOrFail((input, options) =>
      Schema.decodeUnknownEffect(CreateMessagePayloadConversion)(input, options).pipe(
        Effect.mapError((error) => error.issue)
      )
    ),
    encode: SchemaGetter.transformOrFail((input, options) =>
      Schema.encodeEffect(CreateMessagePayloadConversion)(input, options).pipe(
        Effect.mapError((error) => error.issue)
      )
    )
  })
)

export class CreateMessage extends Rpc.make("sampling/createMessage", {
  success: CreateMessageResult,
  error: McpError,
  payload: CreateMessagePayload
}) {}

export const PromptArgument = Schema.Struct({
  name: Schema.String,
  title: optional(Schema.String),
  description: optional(Schema.String),
  required: optional(Schema.Boolean)
})

export const Prompt = Schema.Struct({
  name: Schema.String,
  title: optional(Schema.String),
  description: optional(Schema.String),
  arguments: optional(Schema.Array(PromptArgument)),
  _meta: optional(JsonObject)
})

export const PromptMessage = Schema.Struct({
  role: Role,
  content: ContentBlock
})

export const ListPromptsResult = result({
  ...PaginatedResultFields,
  prompts: Schema.Array(Prompt)
})

export const GetPromptResult = result({
  description: optional(Schema.String),
  messages: Schema.Array(PromptMessage)
})

export class ListPrompts extends Rpc.make("prompts/list", {
  success: ListPromptsResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequest)
}) {}

export class GetPrompt extends Rpc.make("prompts/get", {
  success: GetPromptResult,
  error: McpError,
  payload: requestParams({
    name: Schema.String,
    arguments: optional(Schema.Record(Schema.String, Schema.String))
  })
}) {}

export const PromptReference = Schema.Struct({
  type: Schema.Literal("ref/prompt"),
  name: Schema.String,
  title: optional(Schema.String)
})

export const ResourceTemplateReference = Schema.Struct({
  type: Schema.Literal("ref/resource"),
  uri: Schema.String
})

export const CompleteResult = result({
  completion: Schema.Struct({
    values: Schema.Array(Schema.String),
    total: optional(Schema.Finite),
    hasMore: optional(Schema.Boolean)
  })
})

export class Complete extends Rpc.make("completion/complete", {
  success: CompleteResult,
  error: McpError,
  payload: requestParams({
    ref: Schema.Union([PromptReference, ResourceTemplateReference]),
    argument: Schema.Struct({
      name: Schema.String,
      value: Schema.String
    }),
    context: optional(Schema.Struct({
      arguments: optional(Schema.Record(Schema.String, Schema.String))
    }))
  })
}) {}

export const ElicitationStringSchema = Schema.Struct({
  type: Schema.Literal("string"),
  title: optional(Schema.String),
  description: optional(Schema.String),
  minLength: optional(Schema.Int),
  maxLength: optional(Schema.Int),
  format: optional(Schema.Literals(["email", "uri", "date", "date-time"])),
  enum: Schema.optionalKey(Schema.Never),
  enumNames: Schema.optionalKey(Schema.Never)
})

export const ElicitationNumberSchema = Schema.Struct({
  type: Schema.Literals(["number", "integer"]),
  title: optional(Schema.String),
  description: optional(Schema.String),
  minimum: optional(Schema.Finite),
  maximum: optional(Schema.Finite)
})

export const ElicitationBooleanSchema = Schema.Struct({
  type: Schema.Literal("boolean"),
  title: optional(Schema.String),
  description: optional(Schema.String),
  default: optional(Schema.Boolean)
})

export const ElicitationEnumSchema = Schema.Struct({
  type: Schema.Literal("string"),
  title: optional(Schema.String),
  description: optional(Schema.String),
  enum: Schema.Array(Schema.String),
  enumNames: optional(Schema.Array(Schema.String)),
  minLength: Schema.optionalKey(Schema.Never),
  maxLength: Schema.optionalKey(Schema.Never),
  format: Schema.optionalKey(Schema.Never)
})

export const ElicitationPrimitiveSchema = Schema.Union([
  ElicitationEnumSchema,
  ElicitationStringSchema,
  ElicitationNumberSchema,
  ElicitationBooleanSchema
])

export const ElicitationRequestedSchema = Schema.Struct({
  type: Schema.Literal("object"),
  properties: Schema.Record(Schema.String, ElicitationPrimitiveSchema),
  required: optional(Schema.Array(Schema.String)),
  additionalProperties: Schema.tagDefaultOmit(false)
})

const ElicitResultWire = Schema.StructWithRest(
  Schema.Struct({
    ...ResultMeta.fields,
    action: Schema.Literals(["accept", "decline", "cancel"]),
    content: optional(Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
    ))
  }),
  [JsonObject]
)

const ElicitAcceptResult = Schema.StructWithRest(
  Schema.Struct({
    ...ResultMeta.fields,
    action: Schema.Literal("accept"),
    content: Schema.Any
  }),
  [Schema.Record(Schema.String, Schema.Any)]
)

const ElicitDeclineResult = Schema.StructWithRest(
  Schema.Struct({
    ...ResultMeta.fields,
    action: Schema.Literals(["decline", "cancel"])
  }),
  [Schema.Record(Schema.String, Schema.Any)]
)

const ElicitResultType = Schema.toType(Schema.Union([
  ElicitAcceptResult,
  ElicitDeclineResult
]))

export const ElicitResult = ElicitResultWire.pipe(
  Schema.decodeTo(ElicitResultType, {
    decode: SchemaGetter.transform((result) => {
      if (result.action === "accept") {
        return {
          ...result,
          action: result.action,
          content: result.content
        }
      }
      return {
        ...result,
        action: result.action
      }
    }),
    encode: SchemaGetter.transform((result) => {
      if (result.action === "accept" && result.content === undefined) {
        const { content: _content, ...withoutContent } = result
        return withoutContent
      }
      return result
    })
  })
)

export class Elicit extends Rpc.make("elicitation/create", {
  success: ElicitResult,
  error: McpError,
  payload: Schema.StructWithRest(
    Schema.Struct({
      ...RequestMeta.fields,
      message: Schema.String,
      requestedSchema: ElicitationRequestedSchema
    }),
    [JsonObject]
  )
}) {}

export const ToolJsonSchema = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal("object"),
    properties: optional(Schema.Record(Schema.String, JsonObject)),
    required: optional(Schema.Array(Schema.String))
  }),
  [Schema.Record(Schema.String, Schema.Json)]
)

export const ToolAnnotations = Schema.Struct({
  title: optional(Schema.String),
  readOnlyHint: optional(Schema.Boolean),
  destructiveHint: optional(Schema.Boolean),
  idempotentHint: optional(Schema.Boolean),
  openWorldHint: optional(Schema.Boolean)
})

export const Tool = Schema.Struct({
  name: Schema.String,
  title: optional(Schema.String),
  description: optional(Schema.String),
  inputSchema: ToolJsonSchema,
  outputSchema: optional(ToolJsonSchema),
  annotations: optional(ToolAnnotations),
  _meta: optional(JsonObject)
})

export const ListToolsResult = result({
  ...PaginatedResultFields,
  tools: Schema.Array(Tool)
})

export const CallToolResult = result({
  content: Schema.Array(ContentBlock),
  structuredContent: optional(JsonObject),
  isError: optional(Schema.Boolean)
})

export class ListTools extends Rpc.make("tools/list", {
  success: ListToolsResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequest)
}) {}

export class CallTool extends Rpc.make("tools/call", {
  success: CallToolResult,
  error: McpError,
  payload: requestParams({
    name: Schema.String,
    arguments: optional(JsonObject)
  })
}) {}
