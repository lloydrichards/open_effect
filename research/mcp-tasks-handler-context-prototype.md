# Handler-facing MCP task context prototype

Implemented on 2026-10-22 following the [livestream assessment](mcp-tasks-execution-context.md).

## Result

`McpTasks.TaskContext` lets a running handler request client input and set a status message. `layerMemory` supplies one context per task. `Execution` retains its existing backend-neutral `create/get/update/cancel` contract.

```ts
const handler = Effect.gen(function*() {
  const task = yield* McpTasks.TaskContext
  yield* task.setStatusMessage("Choose workspace roots")
  const response = yield* task.requestInput({
    key: "workspace-roots",
    request: { method: "roots/list" },
    response: Schema.Struct({
      roots: Schema.Array(Schema.Struct({ uri: Schema.String }))
    })
  })
  yield* task.setStatusMessage("Report ready")
  return `Report covers ${response.roots.length} roots`
})
```

The decoder determines the value received by the handler. It can require application services, which the memory adapter captures from the requesting handler. The MCP request remains an explicit protocol request; the decoder does not generate its payload.

Source: [TaskContext and memory implementation](../packages/effect/src/ai/McpTasks.ts).

## Memory behavior

- Publishing a request changes the task to `input_required`. Concurrent waits expose all unanswered requests. Subsequent rounds need new keys.
- An update validates all new responses before accepting any of them. Invalid responses and unknown keys return `TaskError` with code `-32602`. Ownership checks happen first.
- Updates can answer a subset of pending requests. The first accepted response wins, and retries for accepted keys are acknowledged without changing the result.
- After effectful decoding, updates recheck the pending requests before committing. Cancellation or an abandoned handler wait cannot be undone by a slow decoder. Concurrent updates cannot complete a request twice.
- Status changes update `lastUpdatedAt` and preserve the working/input state. The latest message remains on terminal tasks; `undefined` clears it.
- Interrupting a wait removes its pending request. Cancelling one task does not affect another. Closing the layer still interrupts its fibers and discards records.

This remains volatile development/test execution. Status is observable through polling, with no new push-notification support. Duplicate request keys are handler defects, rather than client update errors. Directly returning `McpSchema.InputRequired` remains unsupported by the supplied adapters; handlers use `TaskContext.requestInput` to suspend instead.

Runtime coverage exercises these behaviors through the service and an MCP HTTP round trip. Type tests check decoded values, decoder service requirements, and removal of the supplied task context from the memory layer's application requirements.

## Workflow implementation

`layerWorkflow` now supplies the same `TaskContext` service. `Execution` is unchanged. The adapter uses the selected Workflow engine for persistence and needs no additional database service. Durability still depends on that engine: `WorkflowEngine.layerMemory` remains volatile.

Sources: [adapter](../packages/effect/src/ai/McpTasks.ts), [durable interaction records](../packages/effect/src/ai/internal/mcpTasksWorkflow.ts).

Input descriptions and status changes are immutable named deferred records in a contiguous journal. Operation keys prevent a replay from appending earlier requests or status changes again. `get` reconstructs the latest message, timestamps, and unanswered inputs. A suspended Workflow is `input_required` only when an explicit client request is outstanding. Internal waits remain `working`. Terminal states hide outstanding inputs and retain the final message.

Each input has a sequence of response candidates and acceptance/rejection decisions. `tasks/update` checks ownership and request keys before submitting a candidate. The resumed handler reconstructs its response decoder using the original request context, validates the candidate, and records its decision. Invalid candidates do not consume the input, and later attempts use the next candidate slot. Successful acknowledgement requires a readable persisted acceptance. Retrying an accepted key preserves the first accepted value, including after restart.

The caller's response must not wait for the candidate's own RPC reply to become readable before looking for the decision. The Cluster engine can resume a handler from its active completion cache before that RPC reply is persisted. The decision carries the candidate ID, so the update can wait for that separate receipt without a circular dependency. If terminal status appears before the receipt, the adapter waits briefly for visibility and reports a retryable internal error rather than claiming rejection.

Updates validate through the Workflow runner, so they may wait while the runner is unavailable. Batches process keys in order and can partially accept responses before encountering an invalid one. The memory adapter still validates the full batch before committing. Both support partial updates and first-accepted-value semantics.

A task-specific durable cancellation signal participates in each input wait's durable race. Explicit task cancellation publishes that signal and delegates to `engine.interrupt`. Input waits can therefore terminate without a client supplying additional data. Disconnecting an update caller or shutting down a runner does not publish cancellation.

## Verified recovery behavior

[SQL-backed HTTP tests](../packages/effect/test/ai/McpServer/McpTasksWorkflow.test.ts) now cover:

- Reconstruction while waiting in each of two input rounds, with status, input payloads, ownership, timestamps, and Activity checkpoints retained.
- Invalid replies rejected by the handler's decoder, unknown keys, unauthorized updates, and retries of already accepted keys.
- Concurrent outstanding inputs, partial replies, competing updates, and reconstruction with one input still pending.
- Cancellation while waiting, retained terminal status after reconstruction, and rejection of late replies.
- Internal deferred waits remaining `working`, status clearing, and retained completed metadata.
- Caller interruption followed by runner shutdown during effectful decoding. The reconstructed handler accepts the original durable candidate, uses the original request metadata, and ignores a replacement value supplied by the retry.

Type tests verify that the Workflow layer supplies `TaskContext` while retaining application and decoder service requirements.

## Prototype limits

Task reads use a projection cache bounded to 256 executions. A cold read reconstructs the projection from durable history; subsequent polls read the journal tail and unresolved inputs, retaining decision cursors so rejected responses are not rescanned. Eviction or runner restart requires another reconstruction. Memory within a cached execution still grows with its journal. Workflow history cleanup owns these records along with the execution. SQL tests count poll-side deferred reads and verify equal warm-poll costs with zero or 24 completed input rounds and rejected responses.

Handler control flow, status-call ordering, and decoders must be replay-safe; change the adapter name for incompatible revisions. Decoders may rerun when an accepted input is replayed. Put external side effects in Activities or use external idempotency keys.

Use `McpTasks.workflowRace` for races containing task input requests. This explicit Workflow adapter helper delegates to `DurableDeferred.raceAll` and records the enclosing race names on input events. Polls and updates read the races' existing durable results, including recorded failures, and resolve losing pending requests as withdrawn. The withdrawal competes with acceptance on the same first-write-wins resolution record, so a stale empty resolution read cannot overwrite acceptance. Nested helpers retain unrelated concurrent requests. Plain `DurableDeferred.raceAll` and generic Workflow suspension do not imply withdrawal. There are no changes to Workflow core or Execution and no separate scope-completion records.

Status messages are exposed through polling. This prototype does not add push notifications.


## Durability review fixes

Status checkpoints use a counter within each durable race path. A cached race can skip its branch-local status calls without shifting the continuation's checkpoint identities.

The explicit `workflowRace` helper supplies race ancestry only around the delegated durable race. Observing its persisted result replaces lifecycle notification. Polls do not infer completion from a handler exit or a storage failure.

A single first-write-wins input resolution records acceptance or withdrawal. Acceptance is persisted before its decision receipt. Interruption cleanup competes for that same resolution, so a late withdrawal cannot override acceptance when a projection is reconstructed. This changes the earlier prototype's history format and status checkpoint identities; use a new adapter name when upgrading existing prototype executions.

SQL regression tests cover branch-local status before cached-race replay, nested helpers, acceptance followed by interruption before decision persistence or during readback, and a poll whose empty resolution read overlaps acceptance and race completion. Warm and reconstructed projections retain acceptance. Original updates acknowledge the canonical accepted resolution even when no decision receipt will be written. Both gap regressions were verified to fail with their fixes temporarily removed.


## Publication and nested restart simplification

Input and status publication use `Workflow.wrapActivityResult` to hold the workflow active until the journal append finishes. The journal's operation keys already deduplicate replay, so separate publication deferreds are unnecessary. Decision receipts retain only submission identity and acceptance; event and resolution records own timestamps.

The nested-race regression covers both an inner winner and an outer winner. For the outer winner, it verifies a durable outer result, an unresolved inner result, and no input resolution before shutdown, without polling task state after completion. The first poll after reconstruction withdraws the skipped descendant, retains unrelated input, and rejects late replies. Restricting withdrawal to only the innermost race makes the regression fail.
