/**
 * Exact MCP v2025-06-18 wire schemas for tools, resources, and prompts.
 *
 * @internal
 */
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

export const PaginatedRequest = Schema.Struct({
  ...RequestMeta.fields,
  cursor: optional(Schema.String)
})

export const PaginatedResult = Schema.Struct({
  ...ResultMeta.fields,
  nextCursor: optional(Schema.String)
})

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

export const Role = Schema.Literals(["user", "assistant"])

export const Annotations = Schema.Struct({
  audience: optional(Schema.Array(Role)),
  priority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
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
  blob: Schema.String
})

export const ResourceContents = Schema.Union([TextResourceContents, BlobResourceContents])

export const ListResourcesResult = Schema.Struct({
  ...PaginatedResult.fields,
  resources: Schema.Array(Resource)
})

export const ListResourceTemplatesResult = Schema.Struct({
  ...PaginatedResult.fields,
  resourceTemplates: Schema.Array(ResourceTemplate)
})

export const ReadResourceResult = Schema.Struct({
  ...ResultMeta.fields,
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
  payload: {
    ...RequestMeta.fields,
    uri: Schema.String
  }
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
  data: Schema.String,
  mimeType: Schema.String,
  annotations: optional(Annotations),
  _meta: optional(JsonObject)
})

export const AudioContent = Schema.Struct({
  type: Schema.Literal("audio"),
  data: Schema.String,
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

export const ListPromptsResult = Schema.Struct({
  ...PaginatedResult.fields,
  prompts: Schema.Array(Prompt)
})

export const GetPromptResult = Schema.Struct({
  ...ResultMeta.fields,
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
  payload: {
    ...RequestMeta.fields,
    name: Schema.String,
    arguments: optional(Schema.Record(Schema.String, Schema.String))
  }
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

export const CompleteResult = Schema.Struct({
  ...ResultMeta.fields,
  completion: Schema.Struct({
    values: Schema.Array(Schema.String),
    total: optional(Schema.Finite),
    hasMore: optional(Schema.Boolean)
  })
})

export class Complete extends Rpc.make("completion/complete", {
  success: CompleteResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    ref: Schema.Union([PromptReference, ResourceTemplateReference]),
    argument: Schema.Struct({
      name: Schema.String,
      value: Schema.String
    }),
    context: optional(Schema.Struct({
      arguments: optional(Schema.Record(Schema.String, Schema.String))
    }))
  }
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

export const ListToolsResult = Schema.Struct({
  ...PaginatedResult.fields,
  tools: Schema.Array(Tool)
})

export const CallToolResult = Schema.Struct({
  ...ResultMeta.fields,
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
  payload: {
    ...RequestMeta.fields,
    name: Schema.String,
    arguments: optional(JsonObject)
  }
}) {}
