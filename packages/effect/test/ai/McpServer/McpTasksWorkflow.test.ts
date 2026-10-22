import { NodeCrypto, NodeFileSystem } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import * as TaskWire from "effect/ai/internal/mcpSchema/v2026_07_28"
import * as TaskWorkflow from "effect/ai/internal/mcpTasksWorkflow"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpSchema from "effect/ai/McpSchema"
import * as McpTasks from "effect/ai/McpTasks"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine"
import * as Entity from "effect/cluster/Entity"
import * as Sharding from "effect/cluster/Sharding"
import * as SingleRunner from "effect/cluster/SingleRunner"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as Activity from "effect/workflow/Activity"
import * as DurableDeferred from "effect/workflow/DurableDeferred"
import * as Workflow from "effect/workflow/Workflow"
import * as WorkflowEngine from "effect/workflow/WorkflowEngine"
import { makeHttpHarness } from "./TestUtils/McpHttpHarness.ts"
import { readMcpHttpResponse } from "./TestUtils/McpHttpResponse.ts"
import { makeServerLayer } from "./TestUtils/McpServerLayer.ts"

const Report = Tool.make("report", { parameters: Tool.EmptyParams, success: Schema.String })
const tools = Toolkit.make(Report)
const resume = DurableDeferred.make("report/resume", { success: Schema.Void })
type Handler = Effect.Effect<
  string,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance | McpSchema.McpRequestContext | McpTasks.TaskContext
>

const database = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const filename = `${directory}/tasks.sqlite`
  return { first: yield* SqliteClient.make({ filename }), second: yield* SqliteClient.make({ filename }) }
}).pipe(Effect.provide([NodeFileSystem.layer, Reactivity.layer]))

const open = Effect.fnUntraced(function*(
  client: SqlClient.SqlClient,
  run: Handler,
  wrapEngine: (engine: WorkflowEngine.WorkflowEngine["Service"]) => WorkflowEngine.WorkflowEngine["Service"] = (
    engine
  ) => engine
) {
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  const context = yield* Layer.build(ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(SingleRunner.layer({
      runnerStorage: "memory",
      shardingConfig: {
        shardsPerGroup: 4,
        availableShardGroups: ["default", "workflow"],
        assignedShardGroups: ["default", "workflow"],
        entityTerminationTimeout: 0,
        refreshAssignmentsInterval: 10,
        shardLockRefreshInterval: 10,
        shardLockExpiration: 1000,
        entityMessagePollInterval: 10,
        sendRetryInterval: 10
      }
    })),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(Layer.succeed(SqlClient.SqlClient, client))
  )).pipe(Scope.provide(scope))
  const engine = wrapEngine(Context.get(context, WorkflowEngine.WorkflowEngine))
  const resumeToken = yield* Deferred.make<DurableDeferred.Token>()
  const handler = Effect.gen(function*() {
    yield* Deferred.succeed(resumeToken, yield* DurableDeferred.token(resume))
    return yield* run
  })
  const sharding = Context.get(context, Sharding.Sharding)
  const registration = McpTasks.toolkit(tools, {
    owner: McpSchema.McpRequestContext.use((request) => Effect.succeed(request.clientInfo?.name ?? "anonymous"))
  }).pipe(Layer.provide(McpTasks.layerWorkflow(tools, { report: () => handler }, { name: "sql-reports" }))).pipe(
    Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, engine)),
    Layer.provideMerge(makeServerLayer({ name: "SqlTasks", protocols: [McpProtocol.v2026_07_28] }))
  )
  const harness = yield* makeHttpHarness(registration).pipe(Scope.provide(scope))
  const drive = Effect.fnUntraced(function*<A, E, R>(effect: Effect.Effect<A, E, R>) {
    const fiber = yield* Effect.forkChild(effect, { startImmediately: true })
    for (let attempt = 0; attempt < 300; attempt++) {
      yield* TestClock.adjust(10)
      yield* sharding.pollStorage
      const exit = fiber.pollUnsafe()
      if (exit) return yield* exit
    }
    return yield* Effect.die("MCP task operation did not finish")
  })
  const request = (method: string, params: Record<string, unknown>, owner = "alice") =>
    drive(Effect.gen(function*() {
      const response = yield* harness.post({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            tenant: method === "tools/call" ? "acme" : "polling-client",
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { "io.modelcontextprotocol/tasks": {} },
              roots: {},
              elicitation: { form: {} }
            },
            "io.modelcontextprotocol/clientInfo": { name: owner, version: "1" }
          }
        }
      }, {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        "Mcp-Name": String(params.name ?? params.taskId ?? "")
      })
      return yield* readMcpHttpResponse(response)
    }))
  const get = (taskId: string) =>
    Effect.flatMap(
      request("tasks/get", { taskId }),
      Schema.decodeUnknownEffect(Schema.Struct({
        result: TaskWire.GetTaskResult
      }))
    ).pipe(Effect.map((response) => response.result))
  const waitFor = Effect.fnUntraced(
    function*(
      taskId: string,
      status: string | ReadonlyArray<string>,
      accept?: (task: typeof TaskWire.GetTaskResult.Type) => boolean
    ) {
      let last
      for (let attempt = 0; attempt < 100; attempt++) {
        const task = yield* get(taskId)
        last = task
        if (
          (typeof status === "string" ? task.status === status : status.includes(task.status)) &&
          (!accept || accept(task))
        ) return task
      }
      return assert.fail(`Task did not reach ${status}: ${JSON.stringify(last)}`)
    }
  )
  const start = Effect.gen(function*() {
    const response = yield* request("tools/call", { name: "report", arguments: {} })
    assert.isTrue(typeof response === "object" && response !== null && "result" in response, JSON.stringify(response))
    return (yield* Schema.decodeUnknownEffect(Schema.Struct({ result: TaskWire.CreateTaskResult }))(response)).result
  })
  const release = drive(Effect.gen(function*() {
    const token = yield* Deferred.await(resumeToken)
    yield* DurableDeferred.succeed(resume, { token, value: undefined }).pipe(
      Effect.provideService(WorkflowEngine.WorkflowEngine, engine)
    )
  }))
  return {
    start,
    engine,
    drive,
    get,
    request,
    waitFor,
    release,
    close: Scope.close(scope, Exit.void)
  }
})

it.effect("should retain the result, timestamps, and owner when a completed SQL task is read by a reconstructed runner", () =>
  Effect.gen(function*() {
    const db = yield* database
    let runs = 0
    const handler = Effect.sync(() => {
      runs++
      return "report ready"
    })
    const first = yield* open(db.first, handler)
    const created = yield* first.start
    const completed = yield* first.waitFor(created.taskId, "completed")
    yield* first.close
    const second = yield* open(db.second, handler)
    const recovered = yield* second.get(created.taskId)
    assert.deepStrictEqual(recovered, completed)
    assert.strictEqual(recovered.ttlMs, null)
    assert.isAtLeast(Date.parse(recovered.lastUpdatedAt), Date.parse(recovered.createdAt))
    assert.strictEqual(runs, 1)
    const denied = yield* second.request("tasks/get", { taskId: created.taskId }, "bob")
    const error = yield* Schema.decodeUnknownEffect(Schema.Struct({ error: McpSchema.McpErrorBase }))(denied)
    assert.strictEqual(error.error.code, -32602)
  }))

it.effect("should preserve original request metadata and completed Activities when a SQL task replays on a reconstructed runner", () =>
  Effect.gen(function*() {
    const db = yield* database
    let checkpoints = 0
    const handler = Effect.gen(function*() {
      const before = yield* McpSchema.McpRequestContext.useSync((context) => context.requestMetadata?.tenant)
      yield* Activity.make({
        name: "build-report",
        execute: Effect.sync(() => {
          checkpoints++
        })
      })
      yield* DurableDeferred.await(resume)
      const after = yield* McpSchema.McpRequestContext.useSync((context) => context.requestMetadata?.tenant)
      return `${before}:${after}`
    })
    const first = yield* open(db.first, handler)
    const created = yield* first.start
    yield* first.get(created.taskId)
    assert.strictEqual(checkpoints, 1)
    yield* first.close
    const second = yield* open(db.second, handler)
    assert.strictEqual((yield* second.get(created.taskId)).status, "working")
    yield* second.release
    const completed = yield* second.waitFor(created.taskId, "completed")
    if (completed.status === "completed") {
      assert.strictEqual(completed.result.structuredContent, "acme:acme")
    }
    assert.strictEqual(checkpoints, 1)
    assert.strictEqual(completed.createdAt, created.createdAt)
  }))

it.effect("should retain the engine outcome when an acknowledged cancellation is followed by runner reconstruction", () =>
  Effect.gen(function*() {
    const db = yield* database
    const handler = DurableDeferred.await(resume).pipe(Effect.as("unused"))
    const first = yield* open(db.first, handler)
    const created = yield* first.start
    yield* first.get(created.taskId)
    const response = yield* first.request("tasks/cancel", { taskId: created.taskId })
    yield* Schema.decodeUnknownEffect(Schema.Struct({ result: TaskWire.TaskAcknowledgement }))(response)
    yield* first.release
    const terminal = yield* first.waitFor(created.taskId, ["completed", "cancelled"])
    yield* first.close
    const second = yield* open(db.second, handler)
    assert.deepStrictEqual(yield* second.get(created.taskId), terminal)
  }))

it.effect("should keep an accepted submission pending until its identity is readable", () =>
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const readingIdentity = yield* Deferred.make<void>()
    const ran = yield* Deferred.make<void>()
    let visible = false
    let runs = 0
    const delayedEngine = WorkflowEngine.WorkflowEngine.of({
      ...engine,
      deferredResult: (deferred) =>
        Effect.suspend(() =>
          deferred.name === "mcp/task/identity" && !visible
            ? Deferred.succeed(readingIdentity, undefined).pipe(Effect.as(Option.none()))
            : engine.deferredResult(deferred)
        )
    })
    const executionContext = yield* Layer.build(
      McpTasks.layerWorkflow(tools, {
        report: Effect.fnUntraced(function*() {
          runs++
          yield* Deferred.succeed(ran, undefined)
          return "finished"
        })
      }, { name: "delayed-identity" }).pipe(
        Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, delayedEngine))
      )
    )
    const execution = Context.get(executionContext, McpTasks.Execution)
    const submission = yield* Effect.forkChild(execution.create({
      toolName: "report",
      arguments: {},
      ownerId: "owner",
      requestContext: { clientId: 1, protocolVersion: "2026-07-28", clientCapabilities: {} }
    }))
    yield* Deferred.await(readingIdentity)
    yield* Deferred.await(ran)
    yield* TestClock.adjust("1 second")
    assert.isUndefined(submission.pollUnsafe())
    visible = true
    yield* TestClock.adjust("10 millis")
    const task = yield* Fiber.join(submission)
    const read = yield* execution.get({ taskId: task.taskId, ownerId: "owner" })
    assert.strictEqual(read.status, "completed")
    assert.deepStrictEqual(read.createdAt, task.createdAt)
    assert.strictEqual(runs, 1)
  }).pipe(Effect.provide(WorkflowEngine.layerMemory)))

const rootsInput = {
  key: "roots",
  request: { method: "roots/list" as const },
  response: Schema.Struct({ roots: Schema.Array(Schema.Struct({ uri: Schema.String })).check(Schema.isMinLength(1)) })
}
const checkError = Effect.fnUntraced(function*(body: unknown, code = -32602) {
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ error: McpSchema.McpErrorBase }))(body)
  assert.strictEqual(decoded.error.code, code)
})

it.effect("should retain durable input rounds and status across runner reconstruction and accept replies through tasks/update", () =>
  Effect.gen(function*() {
    const db = yield* database
    let checkpoints = 0
    const handler = Effect.gen(function*() {
      const task = yield* McpTasks.TaskContext
      yield* Activity.make({ name: "prepare", execute: Effect.sync(() => checkpoints++) })
      yield* task.setStatusMessage("Choose workspace roots")
      const roots = yield* task.requestInput(rootsInput)
      yield* Activity.make({ name: "build", execute: Effect.sync(() => checkpoints++) })
      yield* task.setStatusMessage("Name the report")
      const name = yield* task.requestInput({
        key: "report-name",
        request: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Report name",
            requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
          }
        },
        response: Schema.Struct({ action: Schema.Literal("accept"), content: Schema.Struct({ name: Schema.String }) })
      })
      yield* task.setStatusMessage("Report ready")
      return `${roots.roots[0]?.uri}:${name.content.name}`
    })
    const first = yield* open(db.first, handler)
    const created = yield* first.start
    const waiting = yield* first.waitFor(created.taskId, "input_required")
    assert.strictEqual(waiting.statusMessage, "Choose workspace roots")
    if (waiting.status === "input_required") {
      assert.deepStrictEqual(waiting.inputRequests, { roots: { method: "roots/list" } })
    }
    yield* first.close

    const second = yield* open(db.second, handler)
    assert.deepStrictEqual(yield* second.get(created.taskId), waiting)
    yield* checkError(
      yield* second.request("tasks/update", {
        taskId: created.taskId,
        inputResponses: { roots: { roots: [] } }
      }, "bob")
    )
    yield* checkError(
      yield* second.request("tasks/update", {
        taskId: created.taskId,
        inputResponses: { unknown: {} }
      })
    )
    yield* checkError(
      yield* second.request("tasks/update", {
        taskId: created.taskId,
        inputResponses: { roots: { roots: [] } }
      })
    )
    const stillWaiting = yield* second.get(created.taskId)
    assert.strictEqual(stillWaiting.status, "input_required")
    assert.strictEqual(stillWaiting.statusMessage, waiting.statusMessage)
    const reply = yield* second.request("tasks/update", {
      taskId: created.taskId,
      inputResponses: { roots: { roots: [{ uri: "file:///workspace" }] } }
    })
    yield* Schema.decodeUnknownEffect(Schema.Struct({ result: TaskWire.TaskAcknowledgement }))(reply)
    const named = yield* second.waitFor(created.taskId, "input_required")
    assert.strictEqual(named.statusMessage, "Name the report")
    if (named.status === "input_required") assert.deepStrictEqual(Object.keys(named.inputRequests), ["report-name"])
    yield* second.request("tasks/update", {
      taskId: created.taskId,
      inputResponses: { roots: { roots: [{ uri: "file:///ignored" }] } }
    })
    assert.strictEqual(checkpoints, 2)
    yield* second.close

    const third = yield* open(db.first, handler)
    assert.deepStrictEqual(yield* third.get(created.taskId), named)
    yield* third.request("tasks/update", {
      taskId: created.taskId,
      inputResponses: { "report-name": { action: "accept", content: { name: "annual" } } }
    })
    const completed = yield* third.waitFor(created.taskId, "completed")
    assert.strictEqual(completed.statusMessage, "Report ready")
    if (completed.status === "completed") {
      assert.strictEqual(completed.result.structuredContent, "file:///workspace:annual")
    }
    assert.strictEqual(checkpoints, 2)
    yield* third.close
    const fourth = yield* open(db.second, handler)
    assert.deepStrictEqual(yield* fourth.get(created.taskId), completed)
  }))

it.effect("should retain partial concurrent input and accept the first of competing replies", () =>
  Effect.gen(function*() {
    const db = yield* database
    const handler = Effect.gen(function*() {
      const task = yield* McpTasks.TaskContext
      const [left, right] = yield* Effect.all([
        task.requestInput({ ...rootsInput, key: "left" }),
        task.requestInput({ ...rootsInput, key: "right" })
      ], { concurrency: "unbounded" })
      return `${left.roots[0]?.uri}:${right.roots[0]?.uri}`
    })
    const first = yield* open(db.first, handler)
    const created = yield* first.start
    const waiting = yield* first.waitFor(
      created.taskId,
      "input_required",
      (task) => task.status === "input_required" && Object.keys(task.inputRequests).length === 2
    )
    if (waiting.status === "input_required") {
      assert.deepStrictEqual(Object.keys(waiting.inputRequests).sort(), ["left", "right"])
    }
    const replies = yield* Effect.all(
      ["A", "B"].map((uri) =>
        first.request("tasks/update", {
          taskId: created.taskId,
          inputResponses: { left: { roots: [{ uri: `file:///${uri}` }] } }
        })
      ),
      { concurrency: "unbounded" }
    )
    for (const reply of replies) {
      yield* Schema.decodeUnknownEffect(Schema.Struct({ result: TaskWire.TaskAcknowledgement }))(reply)
    }
    const partial = yield* first.waitFor(
      created.taskId,
      "input_required",
      (task) => task.status === "input_required" && Object.keys(task.inputRequests).length === 1
    )
    if (partial.status === "input_required") assert.deepStrictEqual(Object.keys(partial.inputRequests), ["right"])
    yield* first.close
    const second = yield* open(db.second, handler)
    assert.deepStrictEqual(yield* second.get(created.taskId), partial)
    yield* second.request("tasks/update", {
      taskId: created.taskId,
      inputResponses: { right: { roots: [{ uri: "file:///C" }] } }
    })
    const completed = yield* second.waitFor(created.taskId, "completed")
    if (completed.status === "completed") {
      assert.include(["file:///A:file:///C", "file:///B:file:///C"], completed.result.structuredContent)
    }
  }))

it.effect("should preserve cancellation and its status message when an input-waiting SQL task is reconstructed", () =>
  Effect.gen(function*() {
    const db = yield* database
    const handler = Effect.gen(function*() {
      const task = yield* McpTasks.TaskContext
      yield* task.setStatusMessage("Waiting for roots")
      const response = yield* task.requestInput(rootsInput)
      return String(response.roots.length)
    })
    const first = yield* open(db.first, handler)
    const created = yield* first.start
    yield* first.waitFor(created.taskId, "input_required")
    yield* first.request("tasks/cancel", { taskId: created.taskId })
    const cancelled = yield* first.waitFor(created.taskId, "cancelled")
    assert.strictEqual(cancelled.statusMessage, "Waiting for roots")
    assert.isFalse("inputRequests" in cancelled)
    yield* first.close
    const second = yield* open(db.second, handler)
    assert.deepStrictEqual(yield* second.get(created.taskId), cancelled)
    yield* checkError(
      yield* second.request("tasks/update", {
        taskId: created.taskId,
        inputResponses: { roots: { roots: [{ uri: "file:///late" }] } }
      })
    )
    assert.deepStrictEqual(yield* second.get(created.taskId), cancelled)
  }))

it.effect("should retain and clear status messages without exposing an internal Workflow wait as client input", () =>
  Effect.gen(function*() {
    const db = yield* database
    const handler = Effect.gen(function*() {
      const task = yield* McpTasks.TaskContext
      yield* task.setStatusMessage("Building report")
      yield* DurableDeferred.await(resume)
      yield* task.setStatusMessage(undefined)
      return "ready"
    })
    const first = yield* open(db.first, handler)
    const created = yield* first.start
    const working = yield* first.waitFor(created.taskId, "working", (task) => task.statusMessage === "Building report")
    assert.isFalse("inputRequests" in working)
    yield* first.close
    const second = yield* open(db.second, handler)
    assert.deepStrictEqual(yield* second.get(created.taskId), working)
    yield* second.release
    const completed = yield* second.waitFor(created.taskId, "completed")
    assert.isUndefined(completed.statusMessage)
    yield* second.close
    const third = yield* open(db.first, handler)
    assert.deepStrictEqual(yield* third.get(created.taskId), completed)
  }))

it.effect("should finish a submitted response after caller interruption and runner shutdown without accepting its retry twice", () =>
  Effect.gen(function*() {
    const db = yield* database
    const decoding = yield* Deferred.make<void>()
    let block = true
    const response = rootsInput.response.pipe(Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformEffect(({ roots }) =>
        Effect.gen(function*() {
          if (block) {
            yield* Deferred.succeed(decoding, undefined)
            return yield* Effect.never
          }
          const context = yield* McpSchema.McpRequestContext
          return `${context.requestMetadata?.tenant}:${roots[0]?.uri}`
        })
      ),
      encode: SchemaGetter.transform(() => ({ roots: [{ uri: "file:///unused" }] }))
    }))
    const handler = McpTasks.TaskContext.use((task) => task.requestInput({ ...rootsInput, response }))
    const first = yield* open(db.first, handler)
    const created = yield* first.start
    yield* first.waitFor(created.taskId, "input_required")
    const caller = yield* first.request("tasks/update", {
      taskId: created.taskId,
      inputResponses: { roots: { roots: [{ uri: "file:///original" }] } }
    }).pipe(Effect.forkChild)
    yield* first.drive(Deferred.await(decoding))
    yield* Fiber.interrupt(caller)
    yield* first.close
    block = false
    const second = yield* open(db.second, handler)
    const acknowledgement = yield* second.request("tasks/update", {
      taskId: created.taskId,
      inputResponses: { roots: { roots: [{ uri: "file:///retry" }] } }
    })
    yield* Schema.decodeUnknownEffect(Schema.Struct({ result: TaskWire.TaskAcknowledgement }))(acknowledgement)
    const completed = yield* second.waitFor(created.taskId, "completed")
    if (completed.status === "completed") {
      assert.strictEqual(completed.result.structuredContent, "acme:file:///original")
    }
  }))

it.effect("should withdraw a skipped input when replay returns a cached durable race winner", () =>
  Effect.gen(function*() {
    const db = yield* database
    const raceFinished = yield* Deferred.make<void>()
    let pauseAfterRace = true
    const afterRace = DurableDeferred.make("report/after-race", { success: Schema.Void })
    const afterRaceToken = yield* Deferred.make<DurableDeferred.Token>()
    let inputCalls = 0
    const handler = Effect.gen(function*() {
      const task = yield* McpTasks.TaskContext
      const result = yield* McpTasks.workflowRace({
        name: "roots-or-skip",
        success: Schema.String,
        error: Schema.Never,
        effects: [
          Effect.sync(() => {
            inputCalls++
          }).pipe(
            Effect.andThen(task.setStatusMessage("Waiting inside race")),
            Effect.andThen(task.requestInput(rootsInput)),
            Effect.as("roots")
          ),
          DurableDeferred.await(resume).pipe(Effect.as("skipped"))
        ]
      })
      if (pauseAfterRace) {
        yield* Deferred.succeed(raceFinished, undefined)
        return yield* Effect.never
      }
      yield* task.setStatusMessage("Continuing after the race")
      yield* Deferred.succeed(afterRaceToken, yield* DurableDeferred.token(afterRace))
      yield* DurableDeferred.await(afterRace)
      return result
    })
    const first = yield* open(db.first, handler)
    const created = yield* first.start
    yield* first.waitFor(created.taskId, "input_required")
    yield* first.release
    yield* first.drive(Deferred.await(raceFinished))
    const callsBeforeRestart = inputCalls
    yield* first.close
    pauseAfterRace = false
    const second = yield* open(db.second, handler)
    const working = yield* second.waitFor(
      created.taskId,
      "working",
      (task) => task.statusMessage === "Continuing after the race"
    )
    assert.strictEqual(inputCalls, callsBeforeRestart)
    assert.isFalse("inputRequests" in working)
    yield* checkError(
      yield* second.request("tasks/update", {
        taskId: created.taskId,
        inputResponses: { roots: { roots: [{ uri: "file:///late" }] } }
      })
    )
    yield* second.close
    const third = yield* open(db.first, handler)
    assert.deepStrictEqual(yield* third.get(created.taskId), working)
    const token = yield* third.drive(Deferred.await(afterRaceToken))
    yield* third.drive(
      DurableDeferred.succeed(afterRace, { token, value: undefined }).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, third.engine)
      )
    )
    const completed = yield* third.waitFor(created.taskId, "completed")
    if (completed.status === "completed") assert.strictEqual(completed.result.structuredContent, "skipped")
  }))

for (const winner of ["inner", "outer"] as const) {
  it.effect(`should withdraw nested input after the ${winner} race wins${winner === "outer" ? " and restarts before withdrawal is polled" : ""}`, () =>
    Effect.gen(function*() {
      const db = yield* database
      const finished = yield* Deferred.make<WorkflowEngine.WorkflowInstance["Service"]>()
      let innerCalls = 0
      const handler = Effect.gen(function*() {
        const task = yield* McpTasks.TaskContext
        const [result, kept] = yield* Effect.all([
          McpTasks.workflowRace({
            name: "outer",
            success: Schema.String,
            error: Schema.Never,
            effects: [
              McpTasks.workflowRace({
                name: "inner",
                success: Schema.String,
                error: Schema.Never,
                effects: [
                  Effect.sync(() => {
                    innerCalls++
                  }).pipe(Effect.andThen(task.requestInput(rootsInput)), Effect.as("roots")),
                  winner === "inner" ? DurableDeferred.await(resume).pipe(Effect.as("skipped")) : Effect.never
                ]
              }),
              winner === "outer" ? DurableDeferred.await(resume).pipe(Effect.as("skipped")) : Effect.never
            ]
          }).pipe(
            Effect.tap(() =>
              Effect.flatMap(WorkflowEngine.WorkflowInstance, (instance) => Deferred.succeed(finished, instance))
            )
          ),
          task.requestInput({ ...rootsInput, key: "kept" })
        ], { concurrency: "unbounded" })
        return `${result}:${kept.roots.length}`
      })
      const first = yield* open(db.first, handler)
      const created = yield* first.start
      yield* first.waitFor(
        created.taskId,
        "input_required",
        (task) => task.status === "input_required" && Object.keys(task.inputRequests).length === 2
      )
      yield* first.release
      const instance = yield* first.drive(Deferred.await(finished))
      if (winner === "outer") {
        yield* first.drive(
          first.engine.deferredResult(DurableDeferred.make("raceAll/outer", {
            success: Schema.String,
            error: Schema.Never
          })).pipe(
            Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
            Effect.repeat({ while: Option.isNone, schedule: Schedule.spaced("10 millis") })
          )
        )
        const inner = yield* first.engine.deferredResult(DurableDeferred.make("raceAll/inner", {
          success: Schema.String,
          error: Schema.Never
        })).pipe(Effect.provideService(WorkflowEngine.WorkflowInstance, instance))
        const unresolved = yield* first.engine.deferredResult(DurableDeferred.make("mcp/task/resolution/\"roots\"", {
          success: Schema.Unknown
        })).pipe(Effect.provideService(WorkflowEngine.WorkflowInstance, instance))
        assert.isTrue(Option.isNone(inner))
        assert.isTrue(Option.isNone(unresolved))
      } else {
        yield* first.waitFor(
          created.taskId,
          "input_required",
          (task) => task.status === "input_required" && Object.keys(task.inputRequests).length === 1
        )
      }
      const callsBeforeRestart = innerCalls
      yield* first.close
      const second = yield* open(db.second, handler)
      const reconstructed = yield* second.get(created.taskId)
      assert.strictEqual(reconstructed.status, "input_required")
      if (reconstructed.status === "input_required") {
        assert.deepStrictEqual(Object.keys(reconstructed.inputRequests), ["kept"])
      }
      assert.strictEqual(innerCalls, callsBeforeRestart)
      yield* checkError(
        yield* second.request("tasks/update", {
          taskId: created.taskId,
          inputResponses: { roots: { roots: [{ uri: "file:///late" }] } }
        })
      )
      yield* second.request("tasks/update", {
        taskId: created.taskId,
        inputResponses: { kept: { roots: [{ uri: "file:///kept" }] } }
      })
      const completed = yield* second.waitFor(created.taskId, "completed")
      if (completed.status === "completed") assert.strictEqual(completed.result.structuredContent, "skipped:1")
    }))
}

it.effect("should poll only new events and unresolved decisions after building a SQL task projection", () =>
  Effect.gen(function*() {
    const warmCosts: Array<number> = []
    for (const history of [0, 24]) {
      const db = yield* database
      let reads: Array<string> | undefined
      const wrapEngine = (
        engine: WorkflowEngine.WorkflowEngine["Service"]
      ): WorkflowEngine.WorkflowEngine["Service"] => ({
        ...engine,
        deferredResult: (deferred) =>
          Effect.flatMap(Effect.serviceOption(Entity.CurrentAddress), (address) =>
            Effect.suspend(() => {
              if (Option.isNone(address)) reads?.push(deferred.name)
              return engine.deferredResult(deferred)
            }))
      })
      const handler = Effect.gen(function*() {
        const task = yield* McpTasks.TaskContext
        for (let index = 0; index < history; index++) {
          yield* task.setStatusMessage(`Preparing ${index}`)
          yield* task.requestInput({ ...rootsInput, key: `previous-${index}` })
        }
        yield* task.setStatusMessage("Waiting for the final input")
        const result = yield* task.requestInput({ ...rootsInput, key: "pending" })
        return String(result.roots.length)
      })
      const first = yield* open(db.first, handler, wrapEngine)
      const created = yield* first.start
      for (let index = 0; index < history; index++) {
        const key = `previous-${index}`
        yield* first.waitFor(
          created.taskId,
          "input_required",
          (task) => task.status === "input_required" && key in task.inputRequests
        )
        yield* first.request("tasks/update", {
          taskId: created.taskId,
          inputResponses: { [key]: { roots: [{ uri: "file:///done" }] } }
        })
      }
      const waiting = yield* first.waitFor(
        created.taskId,
        "input_required",
        (task) => task.status === "input_required" && "pending" in task.inputRequests
      )
      for (let index = 0; index < history; index++) {
        yield* checkError(
          yield* first.request("tasks/update", { taskId: created.taskId, inputResponses: { pending: { roots: [] } } })
        )
      }
      yield* first.get(created.taskId)
      reads = []
      assert.deepStrictEqual(yield* first.get(created.taskId), waiting)
      warmCosts.push(reads.length)
      assert.strictEqual(reads.filter((name) => name.startsWith("mcp/task/events/")).length, 1)
      assert.isFalse(reads.some((name) => name.includes("previous-")))
      if (history > 0) assert.isFalse(reads.includes("mcp/task/decision/[\"pending\",0]"))
      reads = undefined
      yield* first.close

      const second = yield* open(db.second, handler, wrapEngine)
      reads = []
      assert.deepStrictEqual(yield* second.get(created.taskId), waiting)
      assert.include(reads, "mcp/task/events/0")
      reads = []
      assert.deepStrictEqual(yield* second.get(created.taskId), waiting)
      assert.strictEqual(reads.length, warmCosts[warmCosts.length - 1])
      assert.strictEqual(reads.filter((name) => name.startsWith("mcp/task/events/")).length, 1)
      assert.isFalse(reads.some((name) => name.includes("previous-")))
      reads = undefined
      yield* second.request("tasks/update", {
        taskId: created.taskId,
        inputResponses: { pending: { roots: [{ uri: "file:///final" }] } }
      })
      yield* second.waitFor(created.taskId, "completed")
    }
    assert.strictEqual(warmCosts[1], warmCosts[0])
  }))

for (const blocked of ["write", "read"] as const) {
  it.effect(`should retain accepted replies when a race interrupts decision ${blocked} and the runner restarts`, () =>
    Effect.gen(function*() {
      const db = yield* database
      const accepting = yield* Deferred.make<void>()
      const handler = Effect.gen(function*() {
        const task = yield* McpTasks.TaskContext
        yield* McpTasks.workflowRace({
          name: "accepted-or-skip",
          success: Schema.String,
          error: Schema.Never,
          effects: [
            task.requestInput(rootsInput).pipe(Effect.as("roots")),
            DurableDeferred.await(resume).pipe(Effect.as("skipped"))
          ]
        })
        yield* task.requestInput({ ...rootsInput, key: "kept" })
        return "done"
      })
      const first = yield* open(db.first, handler, (engine) => ({
        ...engine,
        deferredDone: (deferred, options) =>
          blocked === "write" && options.deferredName === "mcp/task/decision/[\"roots\",0]"
            ? Deferred.succeed(accepting, undefined).pipe(Effect.andThen(Effect.never))
            : engine.deferredDone(deferred, options),
        deferredResult: (deferred) =>
          engine.deferredResult(deferred).pipe(
            Effect.flatMap((result) =>
              Effect.flatMap(Effect.serviceOption(Entity.CurrentAddress), (address) =>
                blocked === "read" && deferred.name === "mcp/task/decision/[\"roots\",0]" && Option.isSome(result) &&
                  Option.isSome(address)
                  ? Deferred.succeed(accepting, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.succeed(result))
            )
          )
      }))
      const created = yield* first.start
      yield* first.waitFor(created.taskId, "input_required")
      const reply = { roots: { roots: [{ uri: "file:///accepted" }] } }
      const originalReply = yield* first.request("tasks/update", { taskId: created.taskId, inputResponses: reply })
      yield* Schema.decodeUnknownEffect(Schema.Struct({ result: TaskWire.TaskAcknowledgement }))(originalReply)
      yield* first.drive(Deferred.await(accepting))
      yield* first.get(created.taskId)
      yield* first.release
      yield* first.waitFor(
        created.taskId,
        "input_required",
        (task) => task.status === "input_required" && "kept" in task.inputRequests
      )
      const warmReply = yield* first.request("tasks/update", { taskId: created.taskId, inputResponses: reply })
      yield* Schema.decodeUnknownEffect(Schema.Struct({ result: TaskWire.TaskAcknowledgement }))(warmReply)
      yield* first.close
      const second = yield* open(db.second, handler)
      const coldReply = yield* second.request("tasks/update", { taskId: created.taskId, inputResponses: reply })
      yield* Schema.decodeUnknownEffect(Schema.Struct({ result: TaskWire.TaskAcknowledgement }))(coldReply)
      yield* second.request("tasks/update", {
        taskId: created.taskId,
        inputResponses: { kept: { roots: [{ uri: "file:///kept" }] } }
      })
      const completed = yield* second.waitFor(created.taskId, "completed")
      if (completed.status === "completed") assert.strictEqual(completed.result.structuredContent, "done")
    }))
}

it.effect("should preserve acceptance when a poll observes race completion after an earlier empty resolution read", () =>
  Effect.gen(function*() {
    const db = yield* database
    const reading = yield* Deferred.make<void>()
    const releaseRead = yield* Deferred.make<void>()
    const raced = yield* Deferred.make<void>()
    const running = yield* Deferred.make<WorkflowEngine.WorkflowInstance["Service"]>()
    let holdRead = false
    const handler = Effect.gen(function*() {
      yield* Deferred.succeed(running, yield* WorkflowEngine.WorkflowInstance)
      const task = yield* McpTasks.TaskContext
      yield* McpTasks.workflowRace({
        name: "poll-race",
        success: Schema.String,
        error: Schema.Never,
        effects: [
          task.requestInput(rootsInput).pipe(Effect.as("roots")),
          DurableDeferred.await(resume).pipe(Effect.as("skipped"))
        ]
      })
      yield* Deferred.succeed(raced, undefined)
      yield* DurableDeferred.await(resume)
      return "done"
    })
    const first = yield* open(db.first, handler, (engine) => ({
      ...engine,
      deferredResult: (deferred) =>
        engine.deferredResult(deferred).pipe(Effect.flatMap((result) => {
          if (!holdRead || deferred.name !== "mcp/task/resolution/\"roots\"" || Option.isSome(result)) {
            return Effect.succeed(result)
          }
          holdRead = false
          return Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRead)),
            Effect.as(result)
          )
        }))
    }))
    const created = yield* first.start
    yield* first.waitFor(created.taskId, "input_required")
    const instance = yield* Deferred.await(running)
    const workflow = Workflow.make(instance.workflow._tag, { payload: {}, idempotencyKey: () => "unused" })
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
    const projection = yield* TaskWorkflow.make(first.engine, workflow, scope)
    holdRead = true
    const polling = yield* projection.snapshot(instance.executionId).pipe(Effect.forkChild)
    yield* Deferred.await(reading)
    const candidate = DurableDeferred.make("mcp/task/input/[\"roots\",0]", {
      success: Schema.Struct({ id: Schema.String, response: Schema.JsonObject })
    })
    yield* first.drive(first.engine.deferredDone(candidate, {
      workflowName: instance.workflow._tag,
      executionId: instance.executionId,
      deferredName: candidate.name,
      exit: Exit.succeed({ id: "accepted", response: { roots: [{ uri: "file:///accepted" }] } })
    }))
    yield* first.drive(Deferred.await(raced))
    yield* first.drive(
      first.engine.deferredResult(DurableDeferred.make("raceAll/poll-race", {
        success: Schema.String,
        error: Schema.Never
      })).pipe(
        Effect.provideService(
          WorkflowEngine.WorkflowInstance,
          WorkflowEngine.WorkflowInstance.initial(workflow, instance.executionId)
        ),
        Effect.repeat({ while: Option.isNone, schedule: Schedule.spaced("10 millis") })
      )
    )
    yield* Deferred.succeed(releaseRead, undefined)
    const snapshot = yield* first.drive(Fiber.join(polling))
    assert.deepStrictEqual(Object.keys(snapshot.inputRequests), [])
    yield* projection.update(instance.executionId, { roots: { roots: [{ uri: "file:///retry" }] } })
    yield* first.close
    const second = yield* open(db.second, handler)
    const reply = yield* second.request("tasks/update", {
      taskId: created.taskId,
      inputResponses: { roots: { roots: [{ uri: "file:///retry" }] } }
    })
    yield* Schema.decodeUnknownEffect(Schema.Struct({ result: TaskWire.TaskAcknowledgement }))(reply)
    yield* second.release
    yield* second.waitFor(created.taskId, "completed")
  }))

it.effect("should withdraw input when replay reads a cached failed Workflow race", () =>
  Effect.gen(function*() {
    const db = yield* database
    const running = yield* Deferred.make<WorkflowEngine.WorkflowInstance["Service"]>()
    const handler = Effect.gen(function*() {
      yield* Deferred.succeed(running, yield* WorkflowEngine.WorkflowInstance)
      const task = yield* McpTasks.TaskContext
      yield* McpTasks.workflowRace({
        name: "failed-input",
        success: Schema.String,
        error: Schema.String,
        effects: [
          task.requestInput(rootsInput).pipe(Effect.as("roots")),
          DurableDeferred.await(resume).pipe(Effect.andThen(Effect.fail("skip")))
        ]
      }).pipe(Effect.catch(() => Effect.void))
      yield* task.requestInput({ ...rootsInput, key: "kept" })
      return "done"
    })
    const first = yield* open(db.first, handler)
    const created = yield* first.start
    yield* first.waitFor(created.taskId, "input_required")
    const instance = yield* Deferred.await(running)
    const failed = DurableDeferred.make("raceAll/failed-input", { success: Schema.String, error: Schema.String })
    yield* first.drive(first.engine.deferredDone(failed, {
      workflowName: instance.workflow._tag,
      executionId: instance.executionId,
      deferredName: failed.name,
      exit: Exit.fail("skip")
    }))
    yield* first.release
    const pending = yield* first.waitFor(
      created.taskId,
      "input_required",
      (task) => task.status === "input_required" && "kept" in task.inputRequests && !("roots" in task.inputRequests)
    )
    yield* first.close
    const second = yield* open(db.second, handler)
    const restored = yield* second.get(created.taskId)
    assert.deepStrictEqual(restored, pending)
    yield* checkError(
      yield* second.request("tasks/update", { taskId: created.taskId, inputResponses: { roots: { roots: [] } } })
    )
    yield* second.request("tasks/update", {
      taskId: created.taskId,
      inputResponses: { kept: { roots: [{ uri: "file:///kept" }] } }
    })
    yield* second.waitFor(created.taskId, "completed")
  }))
