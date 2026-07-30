/**
 * Defines the MCP protocol implementations that an `McpServer` can support.
 *
 * @since 4.0.0
 */
import {
  type ProtocolAdapter as ProtocolAdapterInternal,
  v2025_06_18 as v2025_06_18Internal
} from "./internal/mcpProtocol/v2025_06_18.ts"
/**
 * The MCP 2025-06-18 protocol implementation.
 *
 * @category protocols
 * @since 4.0.0
 */
export const v2025_06_18 = v2025_06_18Internal

/**
 * An implemented MCP protocol that can be supplied to `McpServer`.
 *
 * @category models
 * @since 4.0.0
 */
export type ProtocolAdapter = ProtocolAdapterInternal

/**
 * The MCP protocol versions implemented by this release.
 *
 * @category models
 * @since 4.0.0
 */
export type ProtocolVersion = ProtocolAdapter["protocolVersion"]
