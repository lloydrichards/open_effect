import { constVoid } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpServer from "effect/unstable/ai/McpServer"

const noopLogger = Logger.make(constVoid)

export const makeServerLayer = (options: {
  readonly name: string
  readonly version?: string | undefined
  readonly protocols?:
    | readonly [
      McpProtocol.ProtocolAdapter,
      ...Array<McpProtocol.ProtocolAdapter>
    ]
    | undefined
  readonly extensions?: Record<`${string}/${string}`, unknown> | undefined
  readonly allowedOrigins?: ReadonlyArray<string> | undefined
}) =>
  McpServer.layerHttp({
    name: options.name,
    version: options.version ?? "1.0.0",
    path: "/mcp",
    protocols: options.protocols ?? [
      McpProtocol.v2025_06_18,
      McpProtocol.v2025_03_26,
      McpProtocol.v2024_11_05
    ],
    extensions: options.extensions,
    allowedOrigins: options.allowedOrigins
  }).pipe(
    Layer.provideMerge(Layer.succeed(
      References.CurrentLoggers,
      new Set([noopLogger])
    ))
  )
