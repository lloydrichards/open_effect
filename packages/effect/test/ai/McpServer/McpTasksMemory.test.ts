import { assert, it } from "@effect/vitest"
import * as McpTasks from "effect/ai/McpTasks"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import { TestClock } from "effect/testing"

const tools = Toolkit.make(Tool.make("report", { success: Schema.String }))
const input = (key: string) => ({
  key,
  request: {
    method: "elicitation/create" as const,
    params: {
      mode: "form",
      message: `Enter ${key}`,
      requestedSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
    }
  },
  response: Schema.Struct({
    action: Schema.Literal("accept"),
    content: Schema.Struct({ value: Schema.NumberFromString })
  })
})
const response = (value: string) => ({ action: "accept", content: { value } })
const open = Effect.fnUntraced(function*(handler: Effect.Effect<string, never, McpTasks.TaskContext>) {
  const context = yield* Layer.build(McpTasks.layerMemory(tools, { report: () => handler }))
  const execution = Context.get(context, McpTasks.Execution)
  const start = execution.create({
    toolName: "report",
    arguments: {},
    ownerId: "alice",
    requestContext: { clientId: 1, protocolVersion: "2026-07-28", clientCapabilities: {} }
  })
  const get = (taskId: string) => execution.get({ taskId, ownerId: "alice" })
  const waitFor = Effect.fnUntraced(function*(taskId: string, predicate: (task: McpTasks.Task) => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const task = yield* get(taskId)
      if (predicate(task)) return task
      yield* Effect.yieldNow
    }
    return assert.fail("Task did not reach the expected state")
  })
  const update = (taskId: string, inputResponses: McpTasks.UpdateRequest["inputResponses"]) =>
    execution.update({ taskId, ownerId: "alice", inputResponses })
  return { execution, start, get, waitFor, update }
})

it.effect("should resume successive input rounds and retain the latest status message on completion", () =>
  Effect.gen(function*() {
    const harness = yield* open(Effect.gen(function*() {
      const task = yield* McpTasks.TaskContext
      yield* task.setStatusMessage("Waiting for the first value")
      const first = yield* task.requestInput(input("first"))
      yield* task.setStatusMessage("Waiting for the second value")
      const second = yield* task.requestInput(input("second"))
      yield* task.setStatusMessage("Report ready")
      return String(first.content.value + second.content.value)
    }))
    const created = yield* harness.start
    const waiting = yield* harness.waitFor(created.taskId, (task) => task.status === "input_required")
    assert.strictEqual(waiting.statusMessage, "Waiting for the first value")
    assert.strictEqual(waiting.status, "input_required")
    if (waiting.status !== "input_required") return
    assert.deepStrictEqual(waiting.inputRequests, { first: input("first").request })
    yield* TestClock.adjust(1000)
    yield* harness.update(created.taskId, { first: response("2") })
    const second = yield* harness.waitFor(
      created.taskId,
      (task) => task.status === "input_required" && "second" in task.inputRequests
    )
    assert.strictEqual(second.statusMessage, "Waiting for the second value")
    assert.notStrictEqual(second.lastUpdatedAt.epochMilliseconds, waiting.lastUpdatedAt.epochMilliseconds)
    yield* harness.update(created.taskId, { second: response("3") })
    const completed = yield* harness.waitFor(created.taskId, (task) => task.status === "completed")
    assert.strictEqual(completed.statusMessage, "Report ready")
    assert.deepStrictEqual(completed.createdAt, created.createdAt)
    assert.isFalse("inputRequests" in completed)
    if (completed.status === "completed") assert.strictEqual(completed.result.structuredContent, "5")
  }))

it.effect("should leave input outstanding after an invalid response or an unauthorized update", () =>
  Effect.gen(function*() {
    const harness = yield* open(
      McpTasks.TaskContext.use((task) => task.requestInput(input("value"))).pipe(
        Effect.map((result) => String(result.content.value))
      )
    )
    const created = yield* harness.start
    const waiting = yield* harness.waitFor(created.taskId, (task) => task.status === "input_required")
    const invalid = yield* Effect.flip(
      harness.update(created.taskId, { value: { action: "accept", content: { value: 42 } } })
    )
    assert.strictEqual(invalid.code, -32602)
    const unknown = yield* Effect.flip(harness.update(created.taskId, { unknown: response("1") }))
    assert.strictEqual(unknown.code, -32602)
    const denied = yield* Effect.flip(harness.execution.update({
      taskId: created.taskId,
      ownerId: "bob",
      inputResponses: { value: response("1") }
    }))
    assert.strictEqual(denied.message, "Unknown taskId")
    assert.deepStrictEqual(yield* harness.get(created.taskId), waiting)
    yield* harness.update(created.taskId, { value: response("7") })
    const completed = yield* harness.waitFor(created.taskId, (task) => task.status === "completed")
    if (completed.status === "completed") assert.strictEqual(completed.result.structuredContent, "7")
  }))

it.effect("should accept partial concurrent input and keep the first accepted reply", () =>
  Effect.gen(function*() {
    const harness = yield* open(Effect.gen(function*() {
      const task = yield* McpTasks.TaskContext
      const results = yield* Effect.all([
        task.requestInput(input("left")),
        task.requestInput(input("right"))
      ], { concurrency: "unbounded" })
      return String(results[0].content.value + results[1].content.value)
    }))
    const created = yield* harness.start
    yield* harness.waitFor(created.taskId, (task) =>
      task.status === "input_required" && Object.keys(task.inputRequests).length === 2)
    yield* Effect.flip(
      harness.update(created.taskId, { left: response("1"), right: { action: "accept", content: { value: 42 } } })
    )
    const unchanged = yield* harness.get(created.taskId)
    if (unchanged.status === "input_required") {
      assert.strictEqual(Object.keys(unchanged.inputRequests).length, 2)
    } else assert.fail("Invalid updates must not consume any requests")
    yield* harness.update(created.taskId, { left: response("2") })
    yield* harness.update(created.taskId, { left: response("999") })
    const partial = yield* harness.get(created.taskId)
    if (partial.status === "input_required") {
      assert.deepStrictEqual(Object.keys(partial.inputRequests), ["right"])
    } else assert.fail("The other input must remain outstanding")
    yield* harness.update(created.taskId, { right: response("3") })
    const completed = yield* harness.waitFor(created.taskId, (task) =>
      task.status === "completed")
    if (completed.status === "completed") assert.strictEqual(completed.result.structuredContent, "5")
  }))

it.effect("should cancel a task waiting for input without affecting another task", () =>
  Effect.gen(function*() {
    const harness = yield* open(
      McpTasks.TaskContext.use((task) => task.requestInput(input("value"))).pipe(
        Effect.map((result) => String(result.content.value))
      )
    )
    const first = yield* harness.start
    const second = yield* harness.start
    yield* harness.waitFor(first.taskId, (task) => task.status === "input_required")
    yield* harness.waitFor(second.taskId, (task) => task.status === "input_required")
    yield* harness.execution.cancel({ taskId: first.taskId, ownerId: "alice" })
    const cancelled = yield* harness.waitFor(first.taskId, (task) => task.status === "cancelled")
    assert.isFalse("inputRequests" in cancelled)
    yield* Effect.flip(harness.update(first.taskId, { value: response("2") }))
    yield* harness.update(second.taskId, { value: response("4") })
    const completed = yield* harness.waitFor(second.taskId, (task) => task.status === "completed")
    if (completed.status === "completed") assert.strictEqual(completed.result.structuredContent, "4")
  }))

it.effect("should remove an abandoned input wait and allow status messages to be cleared", () =>
  Effect.gen(function*() {
    const stop = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const harness = yield* open(Effect.gen(function*() {
      const task = yield* McpTasks.TaskContext
      const waiting = yield* task.requestInput(input("abandoned")).pipe(Effect.forkChild)
      yield* Deferred.await(stop)
      yield* Fiber.interrupt(waiting)
      yield* task.setStatusMessage("Still working")
      yield* Deferred.await(finish)
      yield* task.setStatusMessage(undefined)
      return "done"
    }))
    const created = yield* harness.start
    yield* harness.waitFor(created.taskId, (task) => task.status === "input_required")
    yield* Deferred.succeed(stop, undefined)
    const working = yield* harness.waitFor(created.taskId, (task) =>
      task.status === "working" &&
      task.statusMessage === "Still working")
    assert.isFalse("inputRequests" in working)
    yield* Deferred.succeed(finish, undefined)
    const completed = yield* harness.waitFor(created.taskId, (task) => task.status === "completed")
    assert.isUndefined(completed.statusMessage)
  }))

for (const cancel of [false, true]) {
  it.effect(`should preserve ${cancel ? "cancellation" : "the first accepted response"} when another update is still decoding`, () =>
    Effect.gen(function*() {
      const decoding = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const value = Schema.String.pipe(Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transformEffect((value) =>
          value === "slow"
            ? Deferred.succeed(decoding, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(value))
            : Effect.succeed(value)
        ),
        encode: SchemaGetter.transform((value) => value)
      }))
      const harness = yield* open(
        McpTasks.TaskContext.use((task) =>
          task.requestInput({
            ...input("value"),
            response: Schema.Struct({ value })
          })
        ).pipe(Effect.map((answer) => answer.value))
      )
      const created = yield* harness.start
      yield* harness.waitFor(created.taskId, (task) => task.status === "input_required")
      const slow = yield* harness.update(created.taskId, { value: { value: "slow" } }).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Deferred.await(decoding)
      if (cancel) {
        yield* harness.execution.cancel({ taskId: created.taskId, ownerId: "alice" })
      } else {
        yield* harness.update(created.taskId, { value: { value: "fast" } })
      }
      const terminal = yield* harness.waitFor(
        created.taskId,
        (task) => task.status === (cancel ? "cancelled" : "completed")
      )
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(slow)
      assert.strictEqual(exit._tag, cancel ? "Failure" : "Success")
      assert.deepStrictEqual(yield* harness.get(created.taskId), terminal)
      if (terminal.status === "completed") assert.strictEqual(terminal.result.structuredContent, "fast")
    }))
}
