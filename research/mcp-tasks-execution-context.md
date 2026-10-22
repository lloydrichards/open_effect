# MCP Tasks execution context

This records the baseline before the handler-service prototype. See [the prototype findings](mcp-tasks-handler-context-prototype.md) for the subsequent implementation and Workflow check.

Reviewed the local production source and the retrieved [livestream](https://www.youtube.com/watch?v=N0XcgJ_khjM) transcript on 2026-10-22. The capture at `/tmp/mcp-stream-transcript.txt` contains 772 timestamped entries. This analysis covers 29:40 through 1:14:46. The transcript is automatically generated, lacks speaker labels, and has not been checked against audio. No runtime behavior was changed or tested. Transcript wording occasionally confuses `poll`, `Deferred`, `Activity`, and interruption. The assessment below uses the surrounding discussion rather than treating those transcription errors as API names.

## Assessment of the livestream discussion

The strongest proposal is to let a running task request client input through a handler-facing service while keeping execution backends replaceable. The discussion also identifies a real lifecycle requirement: stopping a server must not turn recoverable durable work into a client-visible cancellation. Other suggestions either describe behavior already present in this checkout or need a narrower interpretation.

The speaker repeatedly qualifies these ideas as exploratory and says the protocol needs checking. At [54:39](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=3279s), the alternative handler service is explicitly presented as design exploration rather than firm PR feedback. These are design leads, not a settled implementation specification.

### Workflow definition versus Activity handler

At [34:09](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=2049s) and [40:05](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=2405s), the suggestion is to derive a Workflow definition from the tool's name and schemas, then provide its implementation through a layer. This would expose Workflow composition directly and make execution, polling, and interruption ordinary Workflow operations.

The current adapter already creates a Workflow definition for each tool and directly runs the toolkit handler inside that Workflow. It does not require handlers to return an Activity definition. `makeHandlers` accepts ordinary toolkit handlers; Activities are optional operations within those handlers. The stream appears to infer a stronger Activity requirement from the example than the current API imposes. Source: [McpTasks.ts:253](../packages/effect/src/ai/McpTasks.ts#L253), [McpTasks.ts:343](../packages/effect/src/ai/McpTasks.ts#L343), [McpTasks.ts:399](../packages/effect/src/ai/McpTasks.ts#L399).

Recommendation: keep the simple handler API and the replaceable `Execution` service. Consider a separate adapter for an existing Workflow definition only if a concrete application needs independently registered workflows. A tool-to-Workflow helper would still need MCP ownership and metadata, schema encoding rules, versioning, and task result conversion. It would not remove those responsibilities. Do not require a single Activity around the entire interactive handler: durable waits and repeated client interaction should be designed as orchestration with appropriately named Activities for replay-sensitive side effects.

### Polling versus reading durable facts

At [38:28](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=2308s), the speaker questions constructing a Workflow instance to read a DurableDeferred. At [40:30](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=2430s), they suggest `Workflow.poll` for completion and the result.

That is sound for the execution result, and current `get` already calls `engine.poll`. The deferred reads serve different purposes: ownership/creation time and terminal time. Around [36:39](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=2199s), the conversation temporarily treats the deferred as if it holds the tool's result. In this checkout it does not. Removing all `readFact` calls in favor of `poll` would therefore discard information needed for authorization and task timestamps. Source: [McpTasks.ts:290](../packages/effect/src/ai/McpTasks.ts#L290), [McpTasks.ts:350](../packages/effect/src/ai/McpTasks.ts#L350), [McpTasks.ts:423](../packages/effect/src/ai/McpTasks.ts#L423).

Recommendation: keep `poll` as the authority for completion and result. Review whether metadata reads can use a cleaner public read API, but require equivalent ownership checks, restart recovery, and read-after-acceptance behavior before replacing the current mechanism. A metadata store is an alternative with its own consistency and cleanup costs.

### Input requests and resume

At [47:47](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=2867s) and [57:29](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=3449s), the speaker proposes a handler operation that publishes an input request and waits for a response. A memory backend could use ordinary Deferred values; a Workflow backend could use DurableDeferred values. At [1:06:16](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=3976s), the conversation settles on working, terminal, and waiting-for-input as the useful externally observable states, with `update` supplying the response.

This is the most useful next feature, but its missing part is handler behavior and backend state, not the existing public task union. `Task` already includes `input_required` and `UpdateRequest` already carries a record of input responses. Neither supplied adapter implements that interaction. `makeHandlers` currently rejects `InputRequired` outcomes. Source: [McpTasks.ts:85](../packages/effect/src/ai/McpTasks.ts#L85), [McpTasks.ts:112](../packages/effect/src/ai/McpTasks.ts#L112), [McpTasks.ts:274](../packages/effect/src/ai/McpTasks.ts#L274).

Keep backend-control operations such as `create/get/update/cancel` distinct from handler operations such as `requestInput` and `setStatusMessage`. The handler needs the current task identity and typed input/result schemas. A separate context service can supply those capabilities without exposing the whole task administration API or making application handlers depend on Workflow.

The durable implementation must persist the outstanding request description before reporting `input_required`. It must reconstruct that description after restart, validate responses, authorize the enclosing task, handle duplicate or late responses, and define partial completion when several requests are outstanding. Stable request names must survive replay and repeated rounds. Raw internal deferred tokens should not become unchecked authority to complete arbitrary wait points.

Completing a DurableDeferred already records a response and wakes the Workflow. Polling should observe that process, not be responsible for advancing execution. The stream's wording at [58:33](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=3513s) is ambiguous on this point. Source: [DurableDeferred.ts:156](../packages/effect/src/workflow/DurableDeferred.ts#L156), [DurableDeferred.ts:624](../packages/effect/src/workflow/DurableDeferred.ts#L624), [WorkflowEngine.ts:393](../packages/effect/src/workflow/WorkflowEngine.ts#L393).

At [1:03:46](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=3826s), the speaker corrects the idea that every suspended Workflow is waiting for client input. Preserve that correction. Timers, child execution, and failure suspension must remain `working` unless an explicit MCP input request exists. `Workflow.Suspended` contains a cause and failure flag, not a persisted MCP request description. Source: [Workflow.ts:632](../packages/effect/src/workflow/Workflow.ts#L632).

Recommendation: prototype one full input round trip behind a backend-neutral handler service, then test multiple rounds, restart while waiting, duplicate updates, invalid responses, concurrent cancellation, and ownership. Keep Cluster as an implementation choice. The suggestion at [59:24](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=3564s) to model task state with a Cluster entity is plausible, but it adds another durable state model and is not necessary merely to expose this service.

### Shutdown versus cancellation

At [1:09:18](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=4158s), the discussion distinguishes server shutdown from explicit task cancellation. At [1:10:15](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=4215s), it also separates client connection lifetime from task lifetime. Both distinctions are necessary for durable tasks.

The current Workflow adapter delegates explicit cancellation to `engine.interrupt`. Its status mapping treats a terminal Workflow exit containing interruption as cancelled. This is appropriate only if the selected engine keeps shutdown/ownership loss separate from terminal interruption. Cluster already has an abandonment path that releases local resources without running durable finalizers so another owner can replay, and activation shutdown permits durable redelivery. Source: [McpTasks.ts:446](../packages/effect/src/ai/McpTasks.ts#L446), [McpTasks.ts:462](../packages/effect/src/ai/McpTasks.ts#L462), [ClusterWorkflowEngine.ts:139](../packages/effect/src/cluster/ClusterWorkflowEngine.ts#L139), [ClusterWorkflowEngine.ts:529](../packages/effect/src/cluster/ClusterWorkflowEngine.ts#L529), [ClusterWorkflowEngine.ts:640](../packages/effect/src/cluster/ClusterWorkflowEngine.ts#L640).

Recommendation: prove server shutdown and client disconnect recovery with the actual persistent engine before adding a generic handler-facing shutdown operation. A handler cannot provide durability merely by hiding an interruption from the client. Memory execution remains volatile by design. Explicit cancellation, engine suspension, owner abandonment, and process shutdown need distinct semantics even when they all interrupt a local fiber.

### Progress, notifications, and protocol uncertainty

The [versioned Tasks extension specification](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks) confirms several distinctions needed here. Creation must wait for durable, readable acceptance. Task notifications use subscriptions; ordinary `notifications/progress` is unsupported for tasks. `statusMessage` is the task feedback field. Input requests contain keyed MCP server-to-client method payloads, rather than an arbitrary schema/value pair. Their keys must remain unique across a task's lifetime. Clients may supply responses partially, and an acknowledged update need not be immediately visible. A completed tool result can have `isError: true`; task `failed` represents a JSON-RPC error. These constraints should shape the prototype rather than the stream's informal state-machine sketches.

The initial claim at [42:20](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=2540s) that there are no notifications is corrected at [48:43](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=2923s) after reading the task shapes. An analysis should retain the correction rather than recommend a polling-only design on the earlier premise.

The proposed `setStatusMessage` handler capability at [1:12:05](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=4325s) is useful for long tasks and fits beside `requestInput`. It requires rules for `lastUpdatedAt`, replay, notification emission, and retention. Status strings should not become an implicit percentage or durable activity log without an explicit contract.

The discussion around [42:38](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=2558s) and [46:06](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=2766s) speculates about batching, accumulating new work, and TTL as a countdown. Those claims are not established by this conversation. They should not justify arbitrary mutable task payloads or automatic execution restart. Likewise, whether volatile production execution conforms to the extension must be checked against the exact protocol version rather than inferred from the project-setup example at [1:12:40](https://www.youtube.com/watch?v=N0XcgJ_khjM&t=4360s).

## Recommended order of work

1. Use the versioned extension's verified durability, notification, input-response, and retention requirements as acceptance criteria.
2. Write a small handler-facing input/status contract while preserving `Execution` and its existing task union.
3. Implement a memory prototype for the interaction semantics, then a Workflow prototype with persisted outstanding requests and stable response identities.
4. Prove restart/disconnect recovery and distinguish it from explicit cancellation using the persistent engine.
5. Revisit Workflow-definition helpers and metadata storage only if those prototypes expose a concrete limitation.

This order takes the stream's strongest ideas without making speculative protocol readings or API reshaping prerequisites for the missing input interaction.

## Current boundaries

`McpTasks.Execution` exposes `create`, `get`, `update`, and `cancel`. An application can implement it without Workflow. Creation must return a readable, durable task with an unguessable identifier; every operation must enforce ownership; cancellation acknowledges intent rather than confirmed termination. `toolkit` adapts this service to MCP tool registration and resolves trusted ownership for each request. Sources: [McpTasks.ts:138](../packages/effect/src/ai/McpTasks.ts#L138), [McpTasks.ts:175](../packages/effect/src/ai/McpTasks.ts#L175).

`layerWorkflow` creates one Workflow definition per tool, named by the adapter name and tool name. Its payload stores arguments, serializable request context, owner, and a random submission ID. Handlers can use Activities. The adapter tells callers to change the name when handlers become incompatible with replay. Source: [McpTasks.ts:309](../packages/effect/src/ai/McpTasks.ts#L309).

Two DurableDeferred records store identity/creation time and terminal time. `get` checks identity and ownership, polls the Workflow result, then maps it to MCP status. Nonterminal results map to `working`; successful completion, interruption, and failure map to their task statuses. The adapter adds no separate task database. Sources: [McpTasks.ts:290](../packages/effect/src/ai/McpTasks.ts#L290), [McpTasks.ts:378](../packages/effect/src/ai/McpTasks.ts#L378), [McpTasks.ts:423](../packages/effect/src/ai/McpTasks.ts#L423).

`create` executes once with `discard: true`, then keeps polling the same execution's identity until the handle can be read. Each call generates a fresh random ID. This protects against duplicate execution caused by an adapter retry after delayed identity visibility; it does not deduplicate independent client submissions after a lost response. `get` bounds terminal-time visibility retries at roughly 200 ms, while submission identity polling is unbounded. Source: [McpTasks.ts:364](../packages/effect/src/ai/McpTasks.ts#L364), [McpTasks.ts:466](../packages/effect/src/ai/McpTasks.ts#L466).

`layerMemory` stores tasks in a Map and runs handlers in fibers tied to the layer scope. Closing the layer clears state. Its documentation explicitly limits it to development and tests because it cannot provide durable creation. Source: [McpTasks.ts:537](../packages/effect/src/ai/McpTasks.ts#L537).

Both supplied adapters reject handlers returning `InputRequired`. Their `update` operations only validate ownership. The general `Execution` contract supports input requests, so an external implementation can support them. Source: [McpTasks.ts:253](../packages/effect/src/ai/McpTasks.ts#L253), [McpTasks.ts:460](../packages/effect/src/ai/McpTasks.ts#L460), [McpTasks.ts:639](../packages/effect/src/ai/McpTasks.ts#L639).
