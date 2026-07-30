import type * as Effect from "../../../Effect.ts"
import * as Schema from "../../../Schema.ts"
import type * as Rpc from "../../rpc/Rpc.ts"
import type * as RpcGroup from "../../rpc/RpcGroup.ts"
import type * as McpSchema from "../McpSchema.ts"
import type * as McpCore from "./mcpCore.ts"

export interface PayloadCodecs {
  readonly decode: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>
  readonly encode: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>
}

/** @internal */
export interface ToolRuntime {
  readonly list: (
    profile: McpCore.ClientProfile | undefined
  ) => ReadonlyArray<McpSchema.Tool>
  readonly call: (
    request: typeof McpSchema.CallTool.payloadSchema.Type
  ) => Effect.Effect<
    McpSchema.CallToolResult,
    McpSchema.InternalError | McpSchema.InvalidParams,
    McpSchema.McpServerClient
  >
}

/** @internal */
export interface AnyProtocolAdapter {
  readonly protocolVersion: string
  readonly transport: {
    readonly acceptsJsonRpcBatches: boolean
    readonly requiresVersionHeader: boolean
  }
  readonly clientRpcs: RpcGroup.Any
  readonly clientNotificationRpcs: RpcGroup.Any
  readonly serverRequestRpcs: RpcGroup.Any
  readonly serverNotificationRpcs: RpcGroup.Any
  readonly payloadCodecs: (rpc: Rpc.AnyWithProps) => PayloadCodecs
}

export interface ProtocolAdapter<
  out Version extends string = string,
  ClientRpcs extends Rpc.Any = Rpc.Any,
  ClientNotificationRpcs extends ClientRpcs = ClientRpcs,
  ServerRequestRpcs extends Rpc.Any = Rpc.Any,
  ServerNotificationRpcs extends Rpc.Any = Rpc.Any,
  ClientHandlerRpcs extends ClientRpcs = never
> {
  readonly protocolVersion: Version
  readonly transport: {
    readonly acceptsJsonRpcBatches: boolean
    readonly requiresVersionHeader: boolean
  }
  readonly clientRpcs: RpcGroup.RpcGroup<ClientRpcs>
  readonly clientNotificationRpcs: RpcGroup.RpcGroup<ClientNotificationRpcs>
  readonly serverRequestRpcs: RpcGroup.RpcGroup<ServerRequestRpcs>
  readonly serverNotificationRpcs: RpcGroup.RpcGroup<ServerNotificationRpcs>
  readonly clientHandlerRpcs: RpcGroup.RpcGroup<ClientHandlerRpcs>
  readonly makeClientHandlers: (
    runtime: ToolRuntime
  ) => RpcGroup.HandlersFrom<ClientHandlerRpcs>
  readonly payloadCodecs: (rpc: Rpc.AnyWithProps) => PayloadCodecs
}

/** @internal */
export const make = <
  const Version extends string,
  ClientRpcs extends Rpc.Any,
  ClientNotificationRpcs extends ClientRpcs,
  ServerRequestRpcs extends Rpc.Any,
  ServerNotificationRpcs extends Rpc.Any,
  ClientHandlerRpcs extends ClientRpcs
>(options: {
  readonly protocolVersion: Version
  readonly transport: {
    readonly acceptsJsonRpcBatches: boolean
    readonly requiresVersionHeader: boolean
  }
  readonly clientRpcs: RpcGroup.RpcGroup<ClientRpcs>
  readonly clientNotificationRpcs: RpcGroup.RpcGroup<ClientNotificationRpcs>
  readonly serverRequestRpcs: RpcGroup.RpcGroup<ServerRequestRpcs>
  readonly serverNotificationRpcs: RpcGroup.RpcGroup<ServerNotificationRpcs>
  readonly clientHandlerRpcs: RpcGroup.RpcGroup<ClientHandlerRpcs>
  readonly makeClientHandlers: (
    runtime: ToolRuntime
  ) => RpcGroup.HandlersFrom<ClientHandlerRpcs>
}): ProtocolAdapter<
  Version,
  ClientRpcs,
  ClientNotificationRpcs,
  ServerRequestRpcs,
  ServerNotificationRpcs,
  ClientHandlerRpcs
> => {
  const payloadCodecsCache = new WeakMap<Rpc.AnyWithProps, PayloadCodecs>()
  const payloadCodecs = (rpc: Rpc.AnyWithProps): PayloadCodecs => {
    let codecs = payloadCodecsCache.get(rpc)
    if (codecs === undefined) {
      const schema = Schema.toCodecJson(rpc.payloadSchema)
      codecs = {
        decode: Schema.decodeUnknownEffect(schema) as PayloadCodecs["decode"],
        encode: Schema.encodeUnknownEffect(schema) as PayloadCodecs["encode"]
      }
      payloadCodecsCache.set(rpc, codecs)
    }
    return codecs
  }
  return {
    ...options,
    payloadCodecs
  }
}
