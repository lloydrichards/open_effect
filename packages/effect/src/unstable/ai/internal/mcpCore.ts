/**
 * Version-neutral MCP registration and execution semantics.
 *
 * @internal
 */
import * as Arr from "../../../Array.ts"
import * as Context from "../../../Context.ts"
import * as Data from "../../../Data.ts"
import * as Effect from "../../../Effect.ts"
import { pipe } from "../../../Function.ts"
import * as Result from "../../../Result.ts"
import * as FindMyWay from "../../http/FindMyWay.ts"
import * as McpSchema from "../McpSchema.ts"

type CompletionContext = typeof McpSchema.Complete.payloadSchema.Type["context"]

/** @internal */
export interface ClientProfile {
  readonly protocolVersion: string
  readonly capabilities: McpSchema.ClientCapabilities
  readonly clientInfo: McpSchema.Implementation
  readonly metadata?: McpSchema.RequestMeta["_meta"] | undefined
}

/** @internal */
export class ToolNotFound extends Data.TaggedError("ToolNotFound")<{
  readonly name: string
}> {}

/** @internal */
export interface ToolDescriptor {
  readonly tool: McpSchema.Tool
  readonly annotations: Context.Context<never>
}

/** @internal */
export interface ToolRegistration extends ToolDescriptor {
  readonly handle: (
    payload: typeof McpSchema.CallTool.payloadSchema.Type["arguments"]
  ) => Effect.Effect<
    McpSchema.CallToolResult,
    McpSchema.InternalError | McpSchema.InvalidParams,
    McpSchema.McpServerClient
  >
}

/** @internal */
export interface Tools {
  readonly registrations: ReadonlyArray<ToolRegistration>
  readonly register: (registration: ToolRegistration) => Effect.Effect<void>
  readonly call: (
    request: typeof McpSchema.CallTool.payloadSchema.Type,
    client: ClientProfile
  ) => Effect.Effect<
    McpSchema.CallToolResult,
    ToolNotFound | McpSchema.InternalError | McpSchema.InvalidParams,
    McpSchema.McpServerClient
  >
}

/** @internal */
export class ResourceNotFound extends Data.TaggedError("ResourceNotFound")<{
  readonly uri: string
}> {}

/** @internal */
export interface ResourceDescriptor {
  readonly resource: McpSchema.Resource
  readonly annotations: Context.Context<never>
}

/** @internal */
export interface ResourceRegistration extends ResourceDescriptor {
  readonly handle: Effect.Effect<
    McpSchema.ReadResourceResult,
    McpSchema.InternalError,
    McpSchema.McpServerClient
  >
}

/** @internal */
export interface ResourceTemplateDescriptor {
  readonly template: McpSchema.ResourceTemplate
  readonly annotations: Context.Context<never>
}

/** @internal */
export interface ResourceTemplateRegistration extends ResourceTemplateDescriptor {
  readonly routerPath: string
  readonly completions: Readonly<
    Record<
      string,
      (
        input: string,
        context: CompletionContext
      ) => Effect.Effect<
        McpSchema.CompleteResult,
        McpSchema.InternalError,
        McpSchema.McpServerClient
      >
    >
  >
  readonly handle: (
    uri: string,
    params: Array<string>
  ) => Effect.Effect<
    McpSchema.ReadResourceResult,
    McpSchema.InvalidParams | McpSchema.InternalError,
    McpSchema.McpServerClient
  >
}

/** @internal */
export interface Resources {
  readonly registrations: ReadonlyArray<ResourceRegistration>
  readonly templateRegistrations: ReadonlyArray<ResourceTemplateRegistration>
  readonly register: (registration: ResourceRegistration) => Effect.Effect<void>
  readonly registerTemplate: (registration: ResourceTemplateRegistration) => Effect.Effect<void>
  readonly read: (
    uri: string
  ) => Effect.Effect<
    McpSchema.ReadResourceResult,
    ResourceNotFound | McpSchema.InvalidParams | McpSchema.InternalError,
    McpSchema.McpServerClient
  >
}

/** @internal */
export class PromptNotFound extends Data.TaggedError("PromptNotFound")<{
  readonly name: string
}> {}

/** @internal */
export interface PromptDescriptor {
  readonly prompt: McpSchema.Prompt
  readonly annotations: Context.Context<never>
}

/** @internal */
export interface PromptRegistration extends PromptDescriptor {
  readonly completions: Readonly<
    Record<
      string,
      (
        input: string,
        context: CompletionContext
      ) => Effect.Effect<
        McpSchema.CompleteResult,
        McpSchema.InternalError,
        McpSchema.McpServerClient
      >
    >
  >
  readonly handle: (
    params: Record<string, string>
  ) => Effect.Effect<
    McpSchema.GetPromptResult,
    McpSchema.InternalError | McpSchema.InvalidParams,
    McpSchema.McpServerClient
  >
}

/** @internal */
export interface Prompts {
  readonly registrations: ReadonlyArray<PromptRegistration>
  readonly register: (registration: PromptRegistration) => Effect.Effect<void>
  readonly get: (
    request: typeof McpSchema.GetPrompt.payloadSchema.Type
  ) => Effect.Effect<
    McpSchema.GetPromptResult,
    PromptNotFound | McpSchema.InternalError | McpSchema.InvalidParams,
    McpSchema.McpServerClient
  >
}

/** @internal */
export class CompletionNotFound extends Data.TaggedError("CompletionNotFound") {}

/** @internal */
export interface Completions {
  readonly complete: (
    request: typeof McpSchema.Complete.payloadSchema.Type
  ) => Effect.Effect<
    McpSchema.CompleteResult,
    CompletionNotFound | McpSchema.InternalError,
    McpSchema.McpServerClient
  >
}

/** @internal */
export interface McpCore {
  readonly tools: Tools
  readonly resources: Resources
  readonly prompts: Prompts
  readonly completions: Completions
}

const isVisible = (
  registration: { readonly annotations: Context.Context<never> },
  client: ClientProfile | undefined
): boolean => {
  if (client === undefined) {
    return true
  }
  const enabledWhen = Context.getOrUndefined(registration.annotations, McpSchema.EnabledWhen)
  return enabledWhen === undefined ||
    enabledWhen({
      protocolVersion: client.protocolVersion,
      capabilities: client.capabilities,
      clientInfo: client.clientInfo,
      ...(client.metadata === undefined ? {} : { _meta: client.metadata })
    })
}

/** @internal */
export const listTools = (
  registrations: ReadonlyArray<ToolDescriptor>,
  client: ClientProfile | undefined
): ReadonlyArray<McpSchema.Tool> =>
  pipe(
    registrations,
    Arr.filter((registration) => isVisible(registration, client)),
    Arr.map((registration) => registration.tool)
  )

/** @internal */
export const listResources = (
  registrations: ReadonlyArray<ResourceDescriptor>,
  client: ClientProfile | undefined
): ReadonlyArray<McpSchema.Resource> =>
  pipe(
    registrations,
    Arr.filter((registration) => isVisible(registration, client)),
    Arr.map((registration) => registration.resource)
  )

/** @internal */
export const listResourceTemplates = (
  registrations: ReadonlyArray<ResourceTemplateDescriptor>,
  client: ClientProfile | undefined
): ReadonlyArray<McpSchema.ResourceTemplate> =>
  pipe(
    registrations,
    Arr.filter((registration) => isVisible(registration, client)),
    Arr.map((registration) => registration.template)
  )

/** @internal */
export const listPrompts = (
  registrations: ReadonlyArray<PromptDescriptor>,
  client: ClientProfile | undefined
): ReadonlyArray<McpSchema.Prompt> =>
  pipe(
    registrations,
    Arr.filter((registration) => isVisible(registration, client)),
    Arr.map((registration) => registration.prompt)
  )

// FindMyWay supports URI schemes at runtime, but its path type only describes slash-prefixed routes.
const asRouterPath = (path: string): FindMyWay.PathInput => path as FindMyWay.PathInput

const makeRouter = <A>(
  registrations: Iterable<A>,
  path: (registration: A) => string
) => {
  const router = FindMyWay.make<A>({
    ignoreTrailingSlash: true,
    ignoreDuplicateSlashes: true,
    caseSensitive: true
  })
  for (const registration of registrations) {
    router.on("GET", asRouterPath(path(registration)), registration)
  }
  return router
}

/** @internal */
export const make: Effect.Effect<McpCore> = Effect.sync(() => {
  const registrations = new Map<string, ToolRegistration>()
  let resourceRegistrations = new Map<string, ResourceRegistration>()
  let resourceRouter = makeRouter(resourceRegistrations.values(), (registration) => registration.resource.uri)
  let templateRegistrations = new Map<string, ResourceTemplateRegistration>()
  let templateRouter = makeRouter(templateRegistrations.values(), (registration) => registration.routerPath)
  let promptRegistrations = new Map<string, PromptRegistration>()
  type CompletionHandler = (
    input: string,
    context: CompletionContext
  ) => Effect.Effect<
    McpSchema.CompleteResult,
    McpSchema.InternalError,
    McpSchema.McpServerClient
  >
  let promptCompletionRegistrations = new Map<
    string,
    ReadonlyMap<string, CompletionHandler>
  >()
  let resourceCompletionRegistrations = new Map<
    string,
    ReadonlyMap<string, CompletionHandler>
  >()

  const tools: Tools = {
    get registrations() {
      return Arr.fromIterable(registrations.values())
    },
    register: (registration) =>
      Effect.sync(() => {
        registrations.set(registration.tool.name, registration)
      }),
    call: Effect.fnUntraced(function*(request, client) {
      const registration = registrations.get(request.name)
      if (registration === undefined || !isVisible(registration, client)) {
        return yield* new ToolNotFound({ name: request.name })
      }
      return yield* registration.handle(request.arguments)
    })
  }

  const resources: Resources = {
    get registrations() {
      return Arr.fromIterable(resourceRegistrations.values())
    },
    get templateRegistrations() {
      return Arr.fromIterable(templateRegistrations.values())
    },
    register: (registration) =>
      Effect.sync(() => {
        const nextRegistrations = new Map(resourceRegistrations)
        nextRegistrations.set(registration.resource.uri, registration)
        const nextRouter = makeRouter(nextRegistrations.values(), (registration) => registration.resource.uri)
        resourceRegistrations = nextRegistrations
        resourceRouter = nextRouter
      }),
    registerTemplate: (registration) =>
      Effect.sync(() => {
        const nextRegistrations = new Map(templateRegistrations)
        nextRegistrations.set(registration.routerPath, registration)
        const nextRouter = makeRouter(nextRegistrations.values(), (registration) => registration.routerPath)
        const nextCompletions = new Map<string, ReadonlyMap<string, CompletionHandler>>()
        for (const current of nextRegistrations.values()) {
          nextCompletions.set(
            current.template.uriTemplate,
            new Map(Object.entries(current.completions))
          )
        }
        templateRegistrations = nextRegistrations
        templateRouter = nextRouter
        resourceCompletionRegistrations = nextCompletions
      }),
    read: Effect.fnUntraced(function*(uri) {
      const resource = resourceRouter.find("GET", uri)
      if (resource !== undefined) {
        return yield* resource.handler.handle
      }
      const match = templateRouter.find("GET", uri)
      if (match === undefined) {
        return yield* new ResourceNotFound({ uri })
      }
      const params = Arr.filterMap(
        Object.values(match.params),
        (value) => Result.fromNullishOr(value, () => undefined)
      )
      return yield* match.handler.handle(uri, params)
    })
  }

  const prompts: Prompts = {
    get registrations() {
      return Arr.fromIterable(promptRegistrations.values())
    },
    register: (registration) =>
      Effect.sync(() => {
        const nextRegistrations = new Map(promptRegistrations)
        const nextCompletions = new Map(promptCompletionRegistrations)
        nextRegistrations.set(registration.prompt.name, registration)
        nextCompletions.set(
          registration.prompt.name,
          new Map(Object.entries(registration.completions))
        )
        promptRegistrations = nextRegistrations
        promptCompletionRegistrations = nextCompletions
      }),
    get: Effect.fnUntraced(function*(request) {
      const registration = promptRegistrations.get(request.name)
      if (registration === undefined) {
        return yield* new PromptNotFound({ name: request.name })
      }
      return yield* registration.handle(request.arguments ?? {})
    })
  }

  const completions: Completions = {
    complete: Effect.fnUntraced(function*(request) {
      const complete = request.ref.type === "ref/resource"
        ? resourceCompletionRegistrations.get(request.ref.uri)?.get(request.argument.name)
        : promptCompletionRegistrations.get(request.ref.name)?.get(request.argument.name)
      if (complete === undefined) {
        return yield* new CompletionNotFound()
      }
      const result = yield* complete(request.argument.value, request.context)
      const values = Arr.take(result.completion.values, 100)
      if (values.length < result.completion.values.length) {
        return McpSchema.CompleteResult.make({
          completion: {
            values,
            total: result.completion.total,
            hasMore: true
          },
          _meta: result._meta
        })
      }
      return McpSchema.CompleteResult.make({
        completion: result.completion.hasMore === undefined
          ? {
            values,
            total: result.completion.total
          }
          : {
            values,
            total: result.completion.total,
            hasMore: result.completion.hasMore
          },
        _meta: result._meta
      })
    })
  }

  return { completions, prompts, resources, tools }
})
