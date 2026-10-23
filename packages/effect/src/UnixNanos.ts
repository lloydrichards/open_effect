/**
 * Exact signed Unix/POSIX epoch nanoseconds, independent of filesystem policy.
 * No calendar, clock, wire encoding, or leap-second interpretation is provided.
 *
 * @stability experimental
 * @since 4.0.7
 */
import * as DateTime from "./DateTime.ts"
import * as Predicate from "./Predicate.ts"
import * as Result from "./Result.ts"
import * as Schema from "./Schema.ts"

/**
 * Schema for signed bigint epoch nanoseconds with the UnixNanos brand.
 *
 * **Details**
 *
 * Accepts every bigint without a Date or signed 64-bit range restriction.
 * Decoding unknown input directly uses ordinary SchemaError failures. This
 * schema does not imply a JSON representation.
 *
 * **Example** (Decode an exact epoch value)
 *
 * ```ts import.meta.vitest
 * import { Result, Schema, UnixNanos } from "effect"
 *
 * Result.getOrThrow(Schema.decodeUnknownResult(UnixNanos.UnixNanos)(123n)) // => 123n
 * ```
 *
 * @stability experimental
 * @category schemas
 * @since 4.0.7
 */
export const UnixNanos = Schema.BigInt.pipe(Schema.brand("UnixNanos"))

/**
 * Exact nanoseconds since the Unix/POSIX epoch, including negative instants.
 *
 * @stability experimental
 * @category models
 * @since 4.0.7
 */
export type UnixNanos = typeof UnixNanos.Type

/**
 * Conversion precision policy. Omission means exact; truncate discards a
 * remainder toward zero, including for negative instants.
 *
 * @stability experimental
 * @category configuration
 * @since 4.0.7
 */
export interface ConversionOptions {
  readonly precision?: "exact" | "truncate"
}

/**
 * Schema for the stable conversion failure reason and safe scalar context.
 *
 * **Details**
 *
 * Context records direction and units without retaining the supplied Date or
 * any unknown input object. Validation precedes range checking, which precedes
 * precision checking. OutOfRange applies to the original nanoseconds before
 * truncation. PrecisionLoss means the chosen exact conversion has a remainder.
 *
 * @stability experimental
 * @category schemas
 * @since 4.0.7
 */
export const ConversionReason = Schema.Struct({
  reason: Schema.Literals(["InvalidInput", "OutOfRange", "PrecisionLoss"]),
  direction: Schema.Literals(["toUnixNanos", "fromUnixNanos"]),
  unit: Schema.Literals(["nanoseconds", "seconds", "milliseconds", "Date", "DateTime"])
})

/**
 * Safe conversion failure context with a discriminated reason.
 *
 * @stability experimental
 * @category models
 * @since 4.0.7
 */
export type ConversionReason = typeof ConversionReason.Type

/**
 * Schema-backed tagged error for an invalid input, range failure, or precision loss.
 *
 * **Details**
 *
 * Checked conversion helpers return this error in Result rather than throwing
 * expected failures. Unrelated defects still throw. Like Schema.TaggedError,
 * the constructor validates fields and the class itself is a schema with
 * fields, make, decoding, encoding, and extension contracts.
 *
 * @stability experimental
 * @category errors
 * @since 4.0.7
 */
export class ConversionError extends Schema.TaggedError<ConversionError>()(
  "ConversionError",
  ConversionReason.fields
) {}

/**
 * Brands exact bigint nanoseconds without scaling or range checks.
 *
 * @stability experimental
 * @category constructors
 * @since 4.0.7
 */
export const fromNanoseconds = (value: bigint): UnixNanos => UnixNanos.make(value)

/**
 * Returns the exact signed bigint nanoseconds.
 *
 * @stability experimental
 * @category destructors
 * @since 4.0.7
 */
export const toNanoseconds = (value: UnixNanos): bigint => value

/**
 * Converts seconds to exact epoch nanoseconds by default.
 *
 * **Details**
 *
 * Multiplies bigint input by 1000000000n. Interprets finite number input using
 * its canonical decimal spelling, including exponent notation, with integer
 * scaling. Rejects NaN and infinities. Negative values denote pre-epoch
 * instants, and negative zero becomes zero. No string coercion occurs.
 *
 * **Gotchas**
 *
 * Exact conversion rejects subnanosecond remainders. Explicit truncate
 * precision discards them toward zero. Digits already lost in a JavaScript
 * number cannot be recovered.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const fromSeconds = (
  value: bigint | number,
  options?: ConversionOptions
): Result.Result<UnixNanos, ConversionError> => fromScaled(value, 9, "seconds", options)

/**
 * Converts milliseconds to exact epoch nanoseconds by default.
 *
 * **Details**
 *
 * Multiplies bigint input by 1000000n. Interprets finite number input using
 * its canonical decimal spelling, including exponent notation, with integer
 * scaling. Rejects NaN and infinities. Negative values denote pre-epoch
 * instants, and negative zero becomes zero. No string coercion occurs.
 *
 * **Gotchas**
 *
 * Exact conversion rejects subnanosecond remainders. Explicit truncate
 * precision discards them toward zero. Digits already lost in a JavaScript
 * number cannot be recovered.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const fromMilliseconds = (
  value: bigint | number,
  options?: ConversionOptions
): Result.Result<UnixNanos, ConversionError> => fromScaled(value, 6, "milliseconds", options)

/**
 * Snapshots a valid Date once and converts its integer epoch milliseconds.
 *
 * **Gotchas**
 *
 * An invalid Date returns InvalidInput. Subsequent Date mutations cannot
 * change the returned value.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const fromDate = (value: Date): Result.Result<UnixNanos, ConversionError> => {
  const decoded = decodeDate(value)
  if (Result.isFailure(decoded)) return failure("InvalidInput", "toUnixNanos", "Date")
  return fromInstantMilliseconds(decoded.success.getTime(), "Date")
}

/**
 * Converts a Utc or Zoned DateTime using its instant milliseconds.
 *
 * **Details**
 *
 * The zone does not change the instant. Validates that the stored instant
 * milliseconds are finite, integral, and within the supported DateTime range
 * of -8640000000000000 through 8640000000000000, inclusive. A malformed,
 * fractional, or out-of-range representation returns InvalidInput. Converts
 * validated milliseconds to bigint nanoseconds without a precision policy.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const fromDateTime = (value: DateTime.DateTime): Result.Result<UnixNanos, ConversionError> => {
  const decoded = decodeDateTime(value)
  if (Result.isFailure(decoded)) return failure("InvalidInput", "toUnixNanos", "DateTime")
  return fromInstantMilliseconds(DateTime.toEpochMillis(decoded.success), "DateTime")
}

/**
 * Converts epoch nanoseconds to a Date with exact millisecond precision by default.
 *
 * **Details**
 *
 * Checks the original nanoseconds against the inclusive range
 * -8640000000000000000000n through 8640000000000000000000n before
 * precision handling. Exact conversion requires divisibility by 1000000n.
 * Explicit truncate divides toward zero, then converts the safe integer
 * milliseconds to a number. Each successful call returns a fresh Date.
 *
 * **Gotchas**
 *
 * A boundary plus one nanosecond returns OutOfRange even when truncation
 * would enter the range. For -1n, exact conversion returns PrecisionLoss;
 * truncate produces epoch millisecond zero.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const toDate = (value: UnixNanos, options?: ConversionOptions): Result.Result<Date, ConversionError> =>
  Result.map(toMilliseconds(value, "Date", options), (milliseconds) => new Date(milliseconds))

/**
 * Converts epoch nanoseconds to a DateTime.Utc with exact millisecond precision by default.
 *
 * **Details**
 *
 * Checks the original nanoseconds against the inclusive range
 * -8640000000000000000000n through 8640000000000000000000n before
 * precision handling. Exact conversion requires divisibility by 1000000n.
 * Explicit truncate divides toward zero, then converts the safe integer
 * milliseconds to a number.
 *
 * **Gotchas**
 *
 * A boundary plus one nanosecond returns OutOfRange even when truncation
 * would enter the range. For -1n, exact conversion returns PrecisionLoss;
 * truncate produces epoch millisecond zero.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const toDateTime = (
  value: UnixNanos,
  options?: ConversionOptions
): Result.Result<DateTime.Utc, ConversionError> =>
  Result.map(toMilliseconds(value, "DateTime", options), (milliseconds) => DateTime.makeUnsafe(milliseconds))

const nanosPerMillisecond = BigInt("1000000")
const maximumNanoseconds = BigInt("8640000000000000000000")
const decodeNanoseconds = Schema.decodeUnknownResult(UnixNanos)
const decodeQuantity = Schema.decodeUnknownResult(Schema.Union([Schema.BigInt, Schema.Finite]))
const decodeDate = Schema.decodeUnknownResult(Schema.declare(Predicate.isDate))
const decodeDateTime = Schema.decodeUnknownResult(Schema.Union([Schema.DateTimeUtc, Schema.DateTimeZoned]))
const decodeInstantMilliseconds = Schema.decodeUnknownResult(
  Schema.Int.check(Schema.isBetween({ minimum: -8_640_000_000_000_000, maximum: 8_640_000_000_000_000 }))
)

const failure = (
  reason: ConversionReason["reason"],
  direction: ConversionReason["direction"],
  unit: ConversionReason["unit"]
): Result.Result<never, ConversionError> => Result.fail(new ConversionError({ reason, direction, unit }))

const fromScaled = (
  value: bigint | number,
  scale: number,
  unit: "seconds" | "milliseconds",
  options?: ConversionOptions
): Result.Result<UnixNanos, ConversionError> => {
  const decoded = decodeQuantity(value)
  if (Result.isFailure(decoded)) return failure("InvalidInput", "toUnixNanos", unit)
  const quantity = decoded.success
  if (typeof quantity === "bigint") return Result.succeed(fromNanoseconds(quantity * BigInt("10") ** BigInt(scale)))

  // Number spelling is the contract, rather than its binary floating-point expansion.
  const [coefficient, exponent = "0"] = String(quantity).toLowerCase().split("e")
  const [whole, fraction = ""] = coefficient.split(".")
  const integer = BigInt(whole + fraction)
  const power = scale + Number(exponent) - fraction.length
  if (power >= 0) return Result.succeed(fromNanoseconds(integer * BigInt("10") ** BigInt(power)))
  const divisor = BigInt("10") ** BigInt(-power)
  if (options?.precision !== "truncate" && integer % divisor !== BigInt("0")) {
    return failure("PrecisionLoss", "toUnixNanos", unit)
  }
  return Result.succeed(fromNanoseconds(integer / divisor))
}

const fromInstantMilliseconds = (
  milliseconds: number,
  unit: "Date" | "DateTime"
): Result.Result<UnixNanos, ConversionError> => {
  const decoded = decodeInstantMilliseconds(milliseconds)
  if (Result.isFailure(decoded)) return failure("InvalidInput", "toUnixNanos", unit)
  return Result.succeed(fromNanoseconds(BigInt(decoded.success) * nanosPerMillisecond))
}

const toMilliseconds = (
  value: UnixNanos,
  unit: "Date" | "DateTime",
  options?: ConversionOptions
): Result.Result<number, ConversionError> => {
  const decoded = decodeNanoseconds(value)
  if (Result.isFailure(decoded)) return failure("InvalidInput", "fromUnixNanos", unit)
  const nanoseconds = decoded.success
  if (nanoseconds < -maximumNanoseconds || nanoseconds > maximumNanoseconds) {
    return failure("OutOfRange", "fromUnixNanos", unit)
  }
  if (options?.precision !== "truncate" && nanoseconds % nanosPerMillisecond !== BigInt("0")) {
    return failure("PrecisionLoss", "fromUnixNanos", unit)
  }
  return Result.succeed(Number(nanoseconds / nanosPerMillisecond))
}
