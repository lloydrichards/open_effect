import type { NonEmptyReadonlyArray } from "../../../Array.ts"
import * as Cause from "../../../Cause.ts"
import * as Effect from "../../../Effect.ts"
import type * as Rpc from "../../rpc/Rpc.ts"
import type * as RpcGroup from "../../rpc/RpcGroup.ts"
import type * as RpcMessage from "../../rpc/RpcMessage.ts"
import type * as ProtocolAdapter from "./protocolAdapter.ts"

type AnyRpcGroup = RpcGroup.RpcGroup<any>

const prefix = (protocol: ProtocolAdapter.AnyProtocolAdapter): string =>
  `@effect/mcp/${encodeURIComponent(protocol.protocolVersion)}/`

const asRpcGroup = (group: RpcGroup.Any): AnyRpcGroup => group as unknown as AnyRpcGroup

/** @internal */
export interface ProtocolRegistry<
  Protocol extends ProtocolAdapter.AnyProtocolAdapter = ProtocolAdapter.AnyProtocolAdapter
> {
  readonly protocols: NonEmptyReadonlyArray<Protocol>
  readonly clientRpcs: AnyRpcGroup
  readonly select: (offeredVersion: string) => Protocol
  readonly routeClientRequest: (
    protocol: Protocol,
    request: RpcMessage.RequestEncoded
  ) => RpcMessage.RequestEncoded
}

/** @internal */
export const make = Effect.fnUntraced(function*<
  const Protocols extends NonEmptyReadonlyArray<ProtocolAdapter.AnyProtocolAdapter>
>(
  protocols: Protocols
) {
  type Protocol = Protocols[number]

  if (protocols.length === 0) {
    return yield* new Cause.IllegalArgumentError(
      "MCP protocol declaration must contain at least one MCP protocol"
    )
  }

  const snapshot = Object.freeze(Array.from(protocols)) as NonEmptyReadonlyArray<Protocol>
  const byVersion = new Map<string, Protocol>()
  for (const protocol of snapshot) {
    if (byVersion.has(protocol.protocolVersion)) {
      return yield* new Cause.IllegalArgumentError(
        `Duplicate MCP protocol version: ${protocol.protocolVersion}`
      )
    }
    byVersion.set(protocol.protocolVersion, protocol)
  }

  let clientRpcs = asRpcGroup(snapshot[0].clientRpcs).prefix(prefix(snapshot[0]))
  for (let i = 1; i < snapshot.length; i++) {
    clientRpcs = clientRpcs.merge(asRpcGroup(snapshot[i].clientRpcs).prefix(prefix(snapshot[i])))
  }

  return {
    protocols: snapshot,
    clientRpcs,
    select: (offeredVersion: string) => byVersion.get(offeredVersion) ?? snapshot[0],
    routeClientRequest: (
      protocol: Protocol,
      request: RpcMessage.RequestEncoded
    ) => ({
      ...request,
      tag: `${prefix(protocol)}${request.tag}`
    })
  } satisfies ProtocolRegistry<Protocol>
})

/** @internal */
export const installHandlers = Effect.fnUntraced(function*<
  Protocol extends ProtocolAdapter.AnyProtocolAdapter,
  ClientRpcs extends Rpc.Any
>(
  registry: ProtocolRegistry<Protocol>,
  protocol: Protocol,
  clientRpcs: RpcGroup.RpcGroup<ClientRpcs>,
  handlers: RpcGroup.HandlersFrom<ClientRpcs>,
  contextMap: Map<string, unknown>
) {
  const handlerContext = yield* clientRpcs.toHandlers(handlers)
  const entries: Array<readonly [string, unknown]> = []
  for (const rpcDefinition of clientRpcs.requests.values()) {
    const protocolRpc = asRpcGroup(protocol.clientRpcs).requests.get(rpcDefinition._tag)
    if (protocolRpc === undefined || !hasSameHandlerContract(rpcDefinition, protocolRpc)) {
      return yield* Effect.die(`MCP handler contract does not match ${rpcDefinition._tag}`)
    }
    const routed = registry.routeClientRequest(protocol, {
      _tag: "Request",
      id: 0,
      tag: rpcDefinition._tag,
      payload: undefined,
      headers: []
    })
    const namespacedRpc = registry.clientRpcs.requests.get(routed.tag)
    const handler = handlerContext.mapUnsafe.get(rpcDefinition.key)
    if (namespacedRpc === undefined || handler === undefined) {
      return yield* Effect.die(`MCP handler registration invariant failed for ${routed.tag}`)
    }
    if (contextMap.has(namespacedRpc.key)) {
      return yield* Effect.die(`MCP handler already registered for ${routed.tag}`)
    }
    entries.push([namespacedRpc.key, handler])
  }
  for (const [key, handler] of entries) {
    contextMap.set(key, handler)
  }
})

const hasSameHandlerContract = (
  first: Rpc.Any,
  second: Rpc.Any
): boolean => {
  if (!hasHandlerContract(first) || !hasHandlerContract(second)) {
    return false
  }
  return first.payloadSchema === second.payloadSchema &&
    first.successSchema === second.successSchema &&
    first.errorSchema === second.errorSchema &&
    first.defectSchema === second.defectSchema &&
    first.middlewares.size === second.middlewares.size &&
    Array.from(first.middlewares).every((middleware) => second.middlewares.has(middleware))
}

const hasHandlerContract = (
  rpc: Rpc.Any
): rpc is Rpc.Any & {
  readonly payloadSchema: unknown
  readonly successSchema: unknown
  readonly errorSchema: unknown
  readonly defectSchema: unknown
  readonly middlewares: ReadonlySet<unknown>
} =>
  "payloadSchema" in rpc &&
  "successSchema" in rpc &&
  "errorSchema" in rpc &&
  "defectSchema" in rpc &&
  "middlewares" in rpc &&
  rpc.middlewares instanceof Set
