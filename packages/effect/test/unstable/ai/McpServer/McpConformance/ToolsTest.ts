import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import { makeMcpStdioHarness } from "../TestUtils/McpStdioHarness.ts"
import { McpConformance, type McpConformanceLayer } from "./McpConformance.ts"

const decodeTools = Schema.decodeUnknownEffect(McpSchema.ListToolsResult)
const decodeCallTool = Schema.decodeUnknownEffect(McpSchema.CallToolResult)

const callTool = (name: string, arguments_: Record<string, unknown> = {}) =>
  Effect.gen(function*() {
    const test = yield* McpConformance
    const initialized = yield* test.initialize({ server: "features" })
    yield* test.notifyInitialized(initialized)
    const response = yield* test.send(initialized, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: arguments_ }
    })
    return yield* test.decodeResult(response).pipe(
      Effect.flatMap((message) => decodeCallTool(message.result))
    )
  })

export const suite = (protocol: McpProtocol.ProtocolAdapter, layer: McpConformanceLayer) =>
  it.layer(layer)(`Mcp Conformance (${protocol.protocolVersion})`, (it) => {
    describe("Tools", () => {
      // Identical requirements in the 2024-11-05, 2025-03-26, and 2025-06-18 specifications.
      describe("Capabilities", () => {
        it.effect("MUST advertise the tools capability when tools are registered", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })

            assert.property(initialized.message.result.capabilities, "tools")
          }))

        it.effect("MUST NOT advertise the tools capability when tools are not supported", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize()

            assert.notProperty(initialized.message.result.capabilities, "tools")
          }))

        it.effect("MUST advertise listChanged when tool list change notifications are supported", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })

            assert.strictEqual(initialized.message.result.capabilities.tools?.listChanged, true)
          }))
      })

      describe("Listing Tools", () => {
        it.effect("MUST list every tool visible to the initialized client", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })
            yield* test.notifyInitialized(initialized)

            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/list",
              params: {}
            })
            const result = yield* test.decodeResult(response).pipe(
              Effect.flatMap((message) => decodeTools(message.result))
            )

            const expected = [
              "DefectTool",
              "EmbeddedResourceTool",
              "ErrorTool",
              "ImageTool",
              "LogLevelTool",
              "MultipleContentTool",
              "TestTool",
              ...(protocol.protocolVersion === "2024-11-05" ? [] : ["AudioTool"]),
              ...(protocol.protocolVersion === "2025-06-18"
                ? ["ResourceLinkTool", "StructuredTool"]
                : [])
            ].sort()
            assert.deepStrictEqual(result.tools.map((tool) => tool.name).sort(), expected)
          }))

        it.effect("SCHEMA preserves tool names and descriptions", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })
            yield* test.notifyInitialized(initialized)
            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/list",
              params: {}
            })
            const result = yield* test.decodeResult(response).pipe(
              Effect.flatMap((message) => decodeTools(message.result))
            )

            const tool = result.tools.find((tool) => tool.name === "TestTool")
            assert.isDefined(tool)
            assert.strictEqual(tool.description, "A test tool")
          }))

        it.effect("MUST return each tool input schema", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })
            yield* test.notifyInitialized(initialized)
            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/list",
              params: {}
            })
            const result = yield* test.decodeResult(response).pipe(
              Effect.flatMap((message) => decodeTools(message.result))
            )

            assert.isTrue(result.tools.every((tool) => tool.inputSchema.type === "object"))
          }))
        if (protocol.protocolVersion === "2025-06-18") {
          // FIX: registerToolkit does not derive the MCP outputSchema from a
          // compatible object-shaped Toolkit success schema, even though tool
          // calls return the encoded success value as structuredContent.
          it.effect.skip("MUST return each declared tool output schema", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize({ server: "features" })
              yield* test.notifyInitialized(initialized)
              const response = yield* test.send(initialized, {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/list",
                params: {}
              })
              const result = yield* test.decodeResult(response).pipe(
                Effect.flatMap((message) => decodeTools(message.result))
              )

              assert.strictEqual(
                result.tools.find((tool) => tool.name === "StructuredTool")?.outputSchema?.type,
                "object"
              )
            }))
        }
      })

      describe("Calling Tools", () => {
        it.effect("MUST call a registered tool with valid arguments", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })
            yield* test.notifyInitialized(initialized)
            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "TestTool",
                arguments: { value: "called" }
              }
            })
            const result = yield* test.decodeResult(response).pipe(
              Effect.flatMap((message) => decodeCallTool(message.result))
            )

            assert.strictEqual(result.isError, false)
            assert.deepStrictEqual(result.content, [{ type: "text", text: JSON.stringify("called") }])
          }))

        it.effect("MUST reject an unknown tool name with a protocol error", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })
            yield* test.notifyInitialized(initialized)
            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "UnknownTool",
                arguments: {}
              }
            })
            const error = yield* test.decodeError(response)

            assert.strictEqual(error.error.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
          }))

        // FIX: Effect currently returns argument-schema failures as a successful tool result with
        // `isError: true`; the dated MCP specifications classify invalid arguments as a JSON-RPC
        // Invalid Params protocol error.
        it.effect.skip("MUST reject arguments that do not match the input schema with a protocol error", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })
            yield* test.notifyInitialized(initialized)
            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "TestTool",
                arguments: { value: 123 }
              }
            })
            const error = yield* test.decodeError(response)

            assert.strictEqual(error.error.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
          }))
        it.effect("MUST not invoke a tool handler when argument validation fails", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            yield* test.resetObservations
            const initialized = yield* test.initialize({ server: "features" })
            yield* test.notifyInitialized(initialized)
            yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "TestTool",
                arguments: { value: 123 }
              }
            })

            assert.strictEqual((yield* test.observations).toolInvocations, 0)
          }))
        it.effect("SCHEMA returns text content", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })
            yield* test.notifyInitialized(initialized)
            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "TestTool",
                arguments: { value: "text" }
              }
            })
            const result = yield* test.decodeResult(response).pipe(
              Effect.flatMap((message) => decodeCallTool(message.result))
            )

            assert.deepStrictEqual(result.content, [{ type: "text", text: JSON.stringify("text") }])
          }))
        it.effect("SCHEMA returns image content", () =>
          Effect.gen(function*() {
            const result = yield* callTool("ImageTool")
            assert.deepStrictEqual(result.content, [{
              type: "image",
              data: new Uint8Array([1, 2, 3]),
              mimeType: "image/png"
            }])
          }))
        if (protocol.protocolVersion !== "2024-11-05") {
          it.effect("SCHEMA returns audio content", () =>
            Effect.gen(function*() {
              const result = yield* callTool("AudioTool")
              assert.deepStrictEqual(result.content, [{
                type: "audio",
                data: new Uint8Array([4, 5, 6]),
                mimeType: "audio/wav"
              }])
            }))
        }
        if (protocol.protocolVersion === "2025-06-18") {
          it.effect("SCHEMA returns resource links", () =>
            Effect.gen(function*() {
              const result = yield* callTool("ResourceLinkTool")
              assert.deepStrictEqual(result.content, [{
                type: "resource_link",
                uri: "file:///test",
                name: "TestResource",
                mimeType: "text/plain"
              }])
            }))
        }
        it.effect("SCHEMA returns embedded resources", () =>
          Effect.gen(function*() {
            const result = yield* callTool("EmbeddedResourceTool")
            assert.deepStrictEqual(result.content, [{
              type: "resource",
              resource: {
                uri: "file:///embedded",
                mimeType: "text/plain",
                text: "embedded"
              }
            }])
          }))
        it.effect("MUST return multiple content items in order", () =>
          Effect.gen(function*() {
            const result = yield* callTool("MultipleContentTool")
            assert.deepStrictEqual(result.content, [
              { type: "text", text: "first" },
              { type: "text", text: "second" }
            ])
          }))
        if (protocol.protocolVersion === "2025-06-18") {
          it.effect("SCHEMA returns structured content", () =>
            Effect.gen(function*() {
              const result = yield* callTool("StructuredTool")
              assert.deepStrictEqual(result.structuredContent, { value: "structured" })
            }))
        }
        it.effect("MUST return tool execution failures with isError", () =>
          Effect.gen(function*() {
            const result = yield* callTool("ErrorTool")
            assert.strictEqual(result.isError, true)
            assert.deepStrictEqual(result.content, [{ type: "text", text: "expected failure" }])
          }))
        it.effect("MUST keep tool execution errors distinct from protocol errors", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })
            yield* test.notifyInitialized(initialized)

            const execution = yield* callTool("ErrorTool")
            const protocolResponse = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "UnknownTool", arguments: {} }
            })
            const protocol = yield* test.decodeError(protocolResponse)

            assert.strictEqual(execution.isError, true)
            assert.strictEqual(protocol.error.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
          }))

        // FIX: Tool-handler defects are currently serialized into both the
        // JSON-RPC error message and data fields.
        it.effect.skip("SHOULD not expose defects or internal error details", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })
            yield* test.notifyInitialized(initialized)
            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "DefectTool", arguments: {} }
            })
            const result = yield* test.decodeError(response)

            assert.notMatch(JSON.stringify(result), /private defect details/)
          }))
      })

      describe("List Changed Notification", () => {
        it.effect("SHOULD send a tool list changed notification when the advertised list changes", () =>
          Effect.gen(function*() {
            const fixture = yield* makeMcpStdioHarness(protocol)
            const supportedProtocolVersions: ReadonlyArray<McpProtocol.ProtocolVersion> = [
              "2024-11-05",
              "2025-03-26",
              "2025-06-18"
            ]
            const makeTool = (name: string) => ({
              tool: new McpSchema.Tool({
                name,
                inputSchema: { type: "object", properties: {} }
              }),
              annotations: Context.empty(),
              supportedProtocolVersions,
              handle: () => Effect.succeed(new McpSchema.CallToolResult({ content: [] }))
            })
            yield* fixture.server.addTool(makeTool("baseline-list-changed-tool"))
            const initialized = yield* fixture.initialize()
            const initializeResult = yield* Schema.decodeUnknownEffect(McpSchema.InitializeResult)(initialized.result)
            assert.strictEqual(
              initializeResult.capabilities.tools?.listChanged,
              true
            )

            yield* fixture.server.addTool(makeTool("dynamic-list-changed-tool"))
            const notification = yield* fixture.awaitOutboundMethod("notifications/tools/list_changed")
            assert.strictEqual(notification.jsonrpc, "2.0")
            assert.strictEqual(notification.method, "notifications/tools/list_changed")
            assert.notProperty(notification, "id")

            const response = yield* fixture.sendRequest("tools/list", {})
            const result = yield* decodeTools(response.result)
            assert.isTrue(result.tools.some((tool) => tool.name === "dynamic-list-changed-tool"))
          }))
      })
    })
  })
