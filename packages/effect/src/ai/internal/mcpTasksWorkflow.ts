/** @internal */
import * as Cache from "../../Cache.ts"
import * as Context from "../../Context.ts"
import * as DateTime from "../../DateTime.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Option from "../../Option.ts"
import * as Result from "../../Result.ts"
import * as Schedule from "../../Schedule.ts"
import * as Schema from "../../Schema.ts"
import type * as Scope from "../../Scope.ts"
import * as Semaphore from "../../Semaphore.ts"
import * as DurableDeferred from "../../workflow/DurableDeferred.ts"
import * as Workflow from "../../workflow/Workflow.ts"
import * as WorkflowEngine from "../../workflow/WorkflowEngine.ts"
import * as McpSchema from "../McpSchema.ts"
import type * as McpTasks from "../McpTasks.ts"
import { TaskError } from "./mcpTasksBinding.ts"

/** @internal */
export const CurrentRaces = Context.Reference<ReadonlyArray<string>>("effect/ai/McpTasks/WorkflowRaces", {
  defaultValue: () => []
})

const InputRequest = Schema.Union([
  Schema.Struct({ method: Schema.Literal("roots/list"), params: Schema.optionalKey(Schema.JsonObject) }),
  Schema.Struct({ method: Schema.Literal("elicitation/create"), params: Schema.JsonObject }),
  Schema.Struct({ method: Schema.Literal("sampling/createMessage"), params: Schema.JsonObject })
])
const Event = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("input"),
    key: Schema.String,
    request: InputRequest,
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
    at: Schema.DateTimeUtc
  }),
  Schema.Struct({
    kind: Schema.Literal("status"),
    key: Schema.String,
    message: Schema.NullOr(Schema.String),
    at: Schema.DateTimeUtc
  })
])
type Event = typeof Event.Type
const event = (index: number) => DurableDeferred.make(`mcp/task/events/${index}`, { success: Event })
const candidate = (key: string, index: number) =>
  DurableDeferred.make(
    `mcp/task/input/${JSON.stringify([key, index])}`,
    { success: Schema.Struct({ id: Schema.String, response: Schema.JsonObject }) }
  )
const decision = (key: string, index: number) =>
  DurableDeferred.make(
    `mcp/task/decision/${JSON.stringify([key, index])}`,
    { success: Schema.Struct({ id: Schema.String, accepted: Schema.Boolean }) }
  )
const resolution = (key: string) =>
  DurableDeferred.make(`mcp/task/resolution/${JSON.stringify(key)}`, {
    success: Schema.Union([
      Schema.Struct({ state: Schema.Literal("accepted"), index: Schema.Number, at: Schema.DateTimeUtc }),
      Schema.Struct({ state: Schema.Literal("withdrawn"), at: Schema.DateTimeUtc })
    ])
  })

const cancellation = DurableDeferred.make("mcp/task/cancellation", { success: Schema.Void })

const invalid = (message: string) => new TaskError({ code: McpSchema.INVALID_PARAMS_ERROR_CODE, message })

/** @internal */
export const make = Effect.fnUntraced(function*<
  Name extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Codec<unknown, unknown>,
  Error extends Schema.Codec<unknown, unknown>
>(
  engine: WorkflowEngine.WorkflowEngine["Service"],
  workflow: Workflow.Workflow<Name, Payload, Success, Error>,
  scope: Scope.Closeable
) {
  const services = (instance: WorkflowEngine.WorkflowInstance["Service"]) =>
    Context.make(WorkflowEngine.WorkflowEngine, engine).pipe(Context.add(WorkflowEngine.WorkflowInstance, instance))
  const external = (executionId: string) =>
    services(WorkflowEngine.WorkflowInstance.initial(workflow, executionId, { scope }))
  const read = <S extends Schema.Constraint>(executionId: string, deferred: DurableDeferred.DurableDeferred<S>) =>
    engine.deferredResult(deferred).pipe(
      Effect.provideContext(external(executionId)),
      Effect.flatMap((exit) => Option.isSome(exit) ? Effect.map(exit.value, Option.some) : Effect.succeedNone)
    )
  const wait = <S extends Schema.Constraint>(executionId: string, deferred: DurableDeferred.DurableDeferred<S>) =>
    read(executionId, deferred).pipe(
      Effect.repeat({ while: Option.isNone, schedule: Schedule.spaced("10 millis") }),
      Effect.flatMap(Effect.fromOption),
      Effect.orDie
    )
  const write = <S extends Schema.Constraint>(
    instance: WorkflowEngine.WorkflowInstance["Service"],
    deferred: DurableDeferred.DurableDeferred<S>,
    value: S["Type"]
  ) =>
    Effect.gen(function*() {
      yield* DurableDeferred.succeed(deferred, {
        token: DurableDeferred.tokenFromExecutionId(deferred, instance),
        value
      })
      return yield* wait(instance.executionId, deferred)
    }).pipe(Effect.provideContext(services(instance)))

  type InputState =
    | { readonly index: number; readonly state: "pending" }
    | { readonly index: number; readonly state: "accepted" | "withdrawn"; readonly at: DateTime.Utc }
  interface Projection {
    readonly gate: Semaphore.Semaphore
    offset: number
    readonly operations: Set<string>
    readonly inputs: Map<string, { readonly event: Extract<Event, { kind: "input" }>; state: InputState }>
    readonly pending: Set<string>
    statusMessage: string | undefined
    lastUpdatedAt: DateTime.Utc | undefined
  }
  const projections = yield* Cache.make({
    capacity: 256,
    lookup: (_executionId: string): Effect.Effect<Projection> =>
      Effect.map(Semaphore.make(1), (gate) => ({
        gate,
        offset: 0,
        operations: new Set(),
        inputs: new Map(),
        pending: new Set(),
        statusMessage: undefined,
        lastUpdatedAt: undefined
      }))
  })
  const withProjection = <A, E, R>(executionId: string, f: (state: Projection) => Effect.Effect<A, E, R>) =>
    Effect.flatMap(
      Cache.get(projections, executionId),
      (state) => Semaphore.withPermit(state.gate, Effect.suspend(() => f(state)))
    )
  const advance = (state: Projection, at: DateTime.Utc) => {
    if (!state.lastUpdatedAt || at.epochMilliseconds > state.lastUpdatedAt.epochMilliseconds) state.lastUpdatedAt = at
  }
  const consume = (state: Projection, entry: Event) => {
    state.offset++
    const operation = JSON.stringify([entry.kind, entry.key])
    if (state.operations.has(operation)) return
    state.operations.add(operation)
    advance(state, entry.at)
    if (entry.kind === "status") state.statusMessage = entry.message ?? undefined
    else {
      state.inputs.set(entry.key, { event: entry, state: { index: 0, state: "pending" } })
      state.pending.add(entry.key)
    }
  }
  const refreshEvents = Effect.fnUntraced(function*(executionId: string, state: Projection) {
    for (;;) {
      const value = yield* read(executionId, event(state.offset))
      if (Option.isNone(value)) return
      consume(state, value.value)
    }
  })
  const refreshInput = Effect.fnUntraced(function*(executionId: string, state: Projection, key: string) {
    const input = state.inputs.get(key)
    if (!input) return yield* Effect.die("Unknown task input key")
    if (input.state.state !== "pending") return input.state
    const resolved = yield* read(executionId, resolution(key))
    if (Option.isSome(resolved)) {
      input.state = {
        index: resolved.value.state === "accepted" ? resolved.value.index : input.state.index,
        state: resolved.value.state,
        at: resolved.value.at
      }
    } else {
      for (;;) {
        const value = yield* read(executionId, decision(key, input.state.index))
        if (Option.isNone(value)) break
        input.state = { index: input.state.index + 1, state: "pending" }
      }
    }
    if (input.state.state === "pending") {
      for (const name of input.event.scopes ?? []) {
        const completed = yield* engine.deferredResult(DurableDeferred.make(name, {
          success: Schema.Unknown,
          error: Schema.Unknown
        })).pipe(Effect.provideContext(external(executionId)))
        if (Option.isNone(completed)) continue
        const resolved = yield* write(
          WorkflowEngine.WorkflowInstance.initial(workflow, executionId, { scope }),
          resolution(key),
          {
            state: "withdrawn",
            at: yield* DateTime.now
          }
        )
        input.state = {
          index: resolved.state === "accepted" ? resolved.index : input.state.index,
          state: resolved.state,
          at: resolved.at
        }
        break
      }
    }
    if (input.state.state !== "pending") {
      state.pending.delete(key)
      advance(state, input.state.at)
    }
    return input.state
  })
  const inputState = (executionId: string, key: string) =>
    withProjection(executionId, (state) =>
      Effect.gen(function*() {
        yield* refreshEvents(executionId, state)
        return yield* refreshInput(executionId, state, key)
      }))
  const snapshot = (executionId: string) =>
    withProjection(executionId, (state) =>
      Effect.gen(function*() {
        yield* refreshEvents(executionId, state)
        const inputRequests: Record<string, McpSchema.McpInputRequest> = Object.create(null)
        for (const key of state.pending) {
          const input = yield* refreshInput(executionId, state, key)
          const entry = state.inputs.get(key)
          if (input.state === "pending" && entry) inputRequests[key] = entry.event.request
        }
        return { inputRequests, statusMessage: state.statusMessage, lastUpdatedAt: state.lastUpdatedAt }
      }))
  const context = Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const keys = new Set<string>()
    const statusIndices = new Map<string, number>()
    const append = (
      entry: Omit<Extract<Event, { kind: "input" }>, "at"> | Omit<Extract<Event, { kind: "status" }>, "at">
    ) =>
      withProjection(instance.executionId, (state) =>
        Effect.gen(function*() {
          for (;;) {
            yield* refreshEvents(instance.executionId, state)
            if (state.operations.has(JSON.stringify([entry.kind, entry.key]))) return
            const actual = yield* write(instance, event(state.offset), { ...entry, at: yield* DateTime.now })
            consume(state, actual)
            if (actual.kind === entry.kind && actual.key === entry.key) return
          }
        }))
    return {
      requestInput: Effect.fnUntraced(function*<A, R>(options: {
        readonly key: string
        readonly request: McpSchema.McpInputRequest
        readonly response: Schema.Decoder<A, R>
      }) {
        if (keys.has(options.key)) return yield* Effect.die(new Error("Task input requires a unique request key"))
        keys.add(options.key)
        const caller = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance)
        const owner = Option.isSome(caller) && caller.value.executionId === instance.executionId
          ? caller.value
          : instance
        const current = services(owner)
        const races = yield* CurrentRaces
        const request = yield* Schema.decodeUnknownEffect(InputRequest)(options.request).pipe(Effect.orDie)
        yield* Workflow.wrapActivityResult(
          append({ kind: "input", key: options.key, request, scopes: races }),
          () => false
        ).pipe(Effect.provideContext(current))
        return yield* Effect.gen(function*() {
          for (let index = 0;; index++) {
            const previous = yield* read(instance.executionId, decision(options.key, index))
            const deferred = candidate(options.key, index)
            const value = yield* DurableDeferred.raceAll({
              name: `mcp/task/input/${JSON.stringify([options.key, index])}`,
              success: Schema.NullOr(deferred.successSchema),
              error: Schema.Never,
              effects: [DurableDeferred.await(deferred), DurableDeferred.await(cancellation).pipe(Effect.as(null))]
            }).pipe(
              Effect.provideContext(current)
            )
            if (value === null) {
              instance.interrupted = true
              return yield* Effect.interrupt
            }
            if (Option.isSome(previous) && !previous.value.accepted) continue
            const { decoded, recorded } = yield* Workflow.wrapActivityResult(
              Effect.gen(function*() {
                const decoded = yield* Schema.decodeUnknownEffect(options.response)(value.response).pipe(Effect.result)
                if (Result.isSuccess(decoded)) {
                  const resolved = yield* write(instance, resolution(options.key), {
                    state: "accepted",
                    index,
                    at: yield* DateTime.now
                  })
                  if (resolved.state === "withdrawn") return yield* Effect.interrupt
                }
                const recorded = yield* write(instance, decision(options.key, index), {
                  id: value.id,
                  accepted: Result.isSuccess(decoded)
                })
                return { decoded, recorded }
              }),
              () => false
            ).pipe(Effect.provideContext(current))
            if (recorded.accepted) {
              if (Result.isFailure(decoded)) return yield* Effect.die(decoded.failure)
              return decoded.success
            }
          }
        }).pipe(
          Effect.onInterrupt(() =>
            owner.suspended || instance.suspended || instance.abandoned || instance.interrupted
              ? Effect.void
              : Effect.asVoid(Effect.flatMap(DateTime.now, (now) =>
                write(instance, resolution(options.key), { state: "withdrawn", at: now })))
          )
        )
      }),
      setStatusMessage: Effect.fnUntraced(function*(message) {
        const caller = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance)
        const owner = Option.isSome(caller) && caller.value.executionId === instance.executionId
          ? caller.value
          : instance
        const current = services(owner)
        const races = yield* CurrentRaces
        const path = JSON.stringify(races)
        const index = statusIndices.get(path) ?? 0
        statusIndices.set(path, index + 1)
        const key = JSON.stringify([races, index])
        yield* Workflow.wrapActivityResult(
          append({ kind: "status", key, message: message ?? null }),
          () => false
        ).pipe(Effect.provideContext(current))
      })
    } satisfies McpTasks.TaskContext["Service"]
  })

  const update = Effect.fnUntraced(function*(executionId: string, responses: McpTasks.UpdateRequest["inputResponses"]) {
    yield* withProjection(executionId, (state) =>
      Effect.gen(function*() {
        yield* refreshEvents(executionId, state)
        for (const key of Object.keys(responses)) {
          if (!state.inputs.has(key)) return yield* invalid("Unknown task input key")
        }
      }))
    for (const [key, response] of Object.entries(responses)) {
      const encoded = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(response).pipe(
        Effect.mapError(() => invalid(`Invalid response for task input '${key}'`))
      )
      const id = crypto.randomUUID()
      for (;;) {
        const state = yield* inputState(executionId, key)
        if (state.state === "accepted") break
        if (state.state === "withdrawn") return yield* invalid("Task input is no longer pending")
        const outcome = yield* engine.poll(workflow, executionId)
        if (Option.isSome(outcome) && outcome.value._tag === "Complete") {
          return yield* invalid("Task is no longer running")
        }
        const deferred = candidate(key, state.index)
        yield* engine.deferredDone(deferred, {
          workflowName: workflow._tag,
          executionId,
          deferredName: deferred.name,
          exit: Exit.succeed({ id, response: encoded })
        })
        let terminalReads = 0
        const result = yield* Effect.gen(function*() {
          const result = yield* read(executionId, decision(key, state.index))
          if (Option.isSome(result)) return result
          const cancelled = yield* read(executionId, cancellation)
          const progress = yield* inputState(executionId, key)
          if (progress.state === "accepted") return Option.some({ id, accepted: true })
          if (Option.isSome(cancelled) || progress.state === "withdrawn") {
            return yield* invalid("Task input is no longer pending")
          }
          const outcome = yield* engine.poll(workflow, executionId)
          if (Option.isSome(outcome) && outcome.value._tag === "Complete" && ++terminalReads >= 20) {
            // Completion can become visible before the decision reply. A retry
            // is safe because the first accepted response is immutable.
            return yield* new TaskError({
              code: McpSchema.INTERNAL_ERROR_CODE,
              message: "Task response decision is not yet available; retry the request"
            })
          }
          return result
        }).pipe(
          Effect.repeat({ while: Option.isNone, schedule: Schedule.spaced("10 millis") }),
          Effect.flatMap((result) =>
            Option.isSome(result) ? Effect.succeed(result.value) : Effect.die("Missing input decision")
          )
        )
        if (result.accepted) break
        if (result.id === id) return yield* invalid(`Invalid response for task input '${key}'`)
      }
    }
  })
  const cancel = (executionId: string) =>
    engine.deferredDone(cancellation, {
      workflowName: workflow._tag,
      executionId,
      deferredName: cancellation.name,
      exit: Exit.void
    })
  return { context, snapshot, update, cancel }
})
