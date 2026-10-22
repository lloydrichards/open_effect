# MCP task interaction: scope and module decision

Assessment dated 2026-10-22. This is research and a recommendation, not a production change or a new runtime validation pass.

## Recommendation

Keep `McpTasks.ts` as the single public module and keep `Execution` backend-neutral. Put the new handler interaction feature in a follow-up to PR #8631. Review the shared `TaskContext`, memory implementation, and durable Workflow semantics together rather than publishing a handler contract that only one supplied backend can satisfy.

Do not merge roughly 400 lines into the facade merely to meet a file-count target. First narrow the guarantees. If that leaves a small adapter, inline its private helpers in `McpTasks.ts`. If retaining the full persistence implementation, one private internal file is defensible. Do not add a public `McpTasksWorkflow` module. Renaming the current file to `internal/mcpTasks.ts` makes sense only if it actually owns shared task runtime implementation, not as a cosmetic rename of Workflow-only code.

## Evidence and current scope

The live [PR #8631 description](https://github.com/Effect-TS/effect/pull/8631), retrieved on the assessment date, explicitly states that the supplied memory and Workflow layers issue no input requests and authorize/ignore updates; external execution services can implement interaction. The PR already contains task registration, routing, lifecycle, ownership, and backend selection. Handler-facing input/status is an additional capability, not needed to fulfill that stated scope.

The local public facade is 847 lines; `internal/mcpTasksWorkflow.ts` is 397 lines. In the local HEAD baseline the facade is 642 lines and the Workflow test file is 270 lines; the current Workflow test file is 983 lines. These are local working-tree measurements, not live PR diff counts. Untracked files are omitted from ordinary `git diff --stat` and must be counted separately.

The private module is cohesive: it implements one durable interaction mechanism and is used by `layerWorkflow`. Its type-only reference to the public module does not create a runtime back-import. It is not required by an export generator, dependency cycle, or another consumer. Its justification is isolating substantial persistence logic. Inlining it would produce about 1,244 lines before any further cleanup and preserve the same state machine.

Sources: [public facade](../packages/effect/src/ai/McpTasks.ts), [private adapter](../packages/effect/src/ai/internal/mcpTasksWorkflow.ts), [Workflow SQL tests](../packages/effect/test/ai/McpServer/McpTasksWorkflow.test.ts), [memory tests](../packages/effect/test/ai/McpServer/McpTasksMemory.test.ts).

## What is sound about the design

`Execution.create/get/update/cancel` serves protocol registration and external job services. `TaskContext.requestInput/setStatusMessage` serves the running handler. Keeping these roles separate lets both supplied backends provide the same handler operations without teaching application handlers about Workflow.

The intended flow is small:

```text
handler requestInput -> publish pending request -> await a response
client tasks/update  -> authorize -> record response -> resume handler
client tasks/get     -> report execution plus outstanding requests
```

The memory adapter can keep a decoder closure and an ordinary Deferred in its process. A reconstructed Workflow cannot recover that closure from storage. It must replay the handler to reconstruct it, or use a different response-validation contract. That difference is the source of real extra work.

The Workflow APIs do not supply an MCP task-state store. `WorkflowEngine.deferredDone/deferredResult` complete/read named durable facts; `poll` reports execution results and suspension. They do not enumerate MCP requests or return request descriptions, status messages, or accepted response keys. A single `DurableDeferred.await` therefore cannot replace the adapter's discoverable state.

Sources: [WorkflowEngine contract](../packages/effect/src/workflow/WorkflowEngine.ts), [DurableDeferred implementation](../packages/effect/src/workflow/DurableDeferred.ts), [protocol projection](../packages/effect/src/ai/internal/mcpProtocol/v2026_07_28.ts), [task binding](../packages/effect/src/ai/internal/mcpTasksBinding.ts).

## Required guarantees versus selected policies

The [pinned Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks#task-update-requests) allows acknowledgement before updated task state is visible. It does not require waiting for an application-specific decoder. The prototype's stronger acknowledgement semantics are an API policy, not a direct consequence of using Workflow.

| Mechanism | Why it exists | Scope judgment |
| --- | --- | --- |
| Durable pending description and stable key | Reconstruct requests and correlate replies | Essential for durable interaction |
| Durable response and replay-safe wait | Resume with the same submitted value | Essential |
| Activity hold and shutdown/cancellation distinction | Prevent suspension during publication and preserve recovery | Essential when using Workflow |
| Candidate sequence and rejection receipts | Wait for arbitrary handler decoder acceptance, then permit retries of invalid replies | Needed for the current stronger contract; revisit the contract first |
| Canonical acceptance/withdrawal resolution | Resolve competing terminal outcomes consistently | Retain while supporting those competing outcomes |
| Event journal and incremental projection | Discover pending inputs/status using immutable deferred storage without rescanning history each poll | One justified implementation choice; removing it requires another discoverable state model |
| Nested race ancestry and `workflowRace` | Withdraw a branch skipped by cached race replay | Additional orchestration beyond a basic sequential exchange |
| Effectful decoders, concurrent requests, batch validation | Rich application semantics | Decide explicitly rather than acquiring them incidentally |

An alternative is to acknowledge a durably stored, protocol-valid reply and let resumed execution handle application validation. That could eliminate synchronous application-decoder receipts. It changes invalid-answer behaviour: the handler must handle validation failure and, if needed, issue a new uniquely identified prompt. It is not a drop-in refactor preserving the current contract.

The [same specification](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks#task-update-requests) recommends ignoring responses for unknown, answered, or superseded keys. The prototype rejects unknown/withdrawn keys and acknowledges accepted ones. Resolve that policy explicitly; do not describe strict rejection as a mandatory protocol rule.

## Proposed PR boundary

1. Finish the current PR with its existing execution and protocol scope. Preserve this interaction work as a prototype for the follow-up; do not delete it as part of this research.
2. In the follow-up, agree on response acknowledgement and application validation semantics before implementing more storage machinery.
3. Deliver the common handler service and the two supplied adapters against a clear supported orchestration model. A sequential first version is reasonable if limitations are explicit. It must still clean up an explicitly interrupted request; the publication-interruption gap found in the preceding review remains unresolved in the current prototype.
4. Include restart while waiting, durable acceptance before response, cancellation versus shutdown, retries, ownership, and publication interruption as acceptance cases. If nested races are supported, retain their ancestor-withdrawal regression. Do not remove durability tests to make the implementation look smaller.
5. Choose file placement after reducing scope. Keep one public API. Avoid adding a generic store, changing Workflow core, or creating a second registration API without an independently demonstrated need.

A smaller implementation cannot simply omit race cleanup while claiming arbitrary Workflow composition, or remove receipts while still promising acknowledgement only after application validation. Those are contract changes that require an explicit decision.

## Validation boundary

Read current local source, the live PR description, and primary protocol documentation. No production files were changed and no new tests were run for this scope assessment. Earlier passing tests and the preceding publication-interruption probe are historical evidence, not fresh validation here. See [protocol research](mcp-tasks-workflow-protocol-scope.md) and [prototype implementation notes](mcp-tasks-handler-context-prototype.md).
