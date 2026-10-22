# MCP task interaction: required scope versus adapter policy

Reviewed 2026-10-22 against the pinned [2026-07-28 Tasks specification](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks) and current local source. This is a scope assessment, not an implementation change or runtime validation.

## Protocol requirements

- Creation must be durable and readable before returning a handle. Polling must include every outstanding input needed to proceed. Request keys must be unique throughout the task. [Task creation](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks#task-creation), [polling](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks#task-polling), [updates](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks#task-update-requests).
- Updates acknowledge with an empty result; visible state may lag. Ignoring unknown, answered, or superseded keys is recommended. Partial responses are permitted. Nothing requires acknowledgement to wait for the application handler's decoder. [Updates](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks#task-update-requests).
- Elicitation during execution uses task input requests and updates. Elicitation before task creation uses the original request's multi-round-trip mechanism. They are distinct flows. [Example flow](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks#example-message-flow).
- Status messages are optional. Cancellation acknowledges intent and need not stop work. [Task shape](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks#tasks), [cancellation](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks#task-cancellation).

## What follows for this prototype

The following conclusions are engineering judgments from those requirements and the local implementation.

The backend-neutral `TaskContext` is a sensible feature boundary: its request and response types already use MCP method payloads, while `Execution` remains the administration interface. Neither interface needs Workflow concepts. See [McpTasks.ts](../packages/effect/src/ai/McpTasks.ts).

Workflow persistence is necessary if `layerWorkflow` claims durable interaction. The specific event journal, projection cache, per-attempt candidates and receipts, race ancestry, and polling retry loops are implementation choices. The specification does not prescribe this orchestration. See [mcpTasksWorkflow.ts](../packages/effect/src/ai/internal/mcpTasksWorkflow.ts).

In particular, waiting for application-decoder acceptance makes `tasks/update` depend on a live/recovered runner. It also explains much of the candidate/decision machinery. A separate design could acknowledge a durably stored protocol-valid response and leave application validation to resumed execution. That changes the handler contract and invalid-answer user experience; it should not be silently substituted as a cleanup.

Automatic withdrawal for arbitrary nested races is additional application orchestration. A narrower first version can support explicitly documented sequential requests without exporting `workflowRace`. It still must avoid advertising requests that no handler can consume. Restricting supported concurrency is more honest than deleting withdrawal tracking while promising unrestricted races.

## Recommendation

Treat memory interaction plus the common service as one review unit, and durable Workflow interaction as a follow-up unless interactive Workflow support is an explicit acceptance criterion for the current PR. The latter requires a storage/replay protocol review, not just wiring elicitation into a layer.

If retaining the full Workflow prototype, keep its private implementation separate: approximately 400 lines implement a genuinely distinct persistence mechanism. Merging that text into the public module reduces file count but does not reduce state or guarantees. A one-file target becomes sensible only after narrowing supported behavior or selecting a simpler acknowledgement contract.

One policy divergence deserves an explicit choice: current `update` rejects unknown or withdrawn keys; the pinned specification recommends ignoring them. This is a SHOULD, not a confirmed MUST violation. No production changes were made to resolve it here.
