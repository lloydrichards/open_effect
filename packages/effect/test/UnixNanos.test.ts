import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as UnixNanos from "effect/UnixNanos"

const nanos = UnixNanos.fromNanoseconds
const success = Result.getOrThrow
const failure = (
  result: Result.Result<unknown, UnixNanos.ConversionError>,
  reason: UnixNanos.ConversionReason["reason"],
  direction: UnixNanos.ConversionReason["direction"],
  unit: UnixNanos.ConversionReason["unit"]
) => {
  assert.isTrue(Result.isFailure(result))
  if (Result.isFailure(result)) {
    assert.instanceOf(result.failure, UnixNanos.ConversionError)
    assert.strictEqual(result.failure.reason, reason)
    assert.strictEqual(result.failure.direction, direction)
    assert.strictEqual(result.failure.unit, unit)
  }
}

describe("UnixNanos", () => {
  it("preserves unrestricted signed bigint nanoseconds through construction and schema decoding", () => {
    for (const value of [0n, -1n, 1n, -(10n ** 100n), 10n ** 100n]) {
      assert.strictEqual(UnixNanos.toNanoseconds(nanos(value)), value)
      assert.strictEqual(success(Schema.decodeUnknownResult(UnixNanos.UnixNanos)(value)), value)
    }
    const decoded = Schema.decodeUnknownResult(UnixNanos.UnixNanos)("1")
    assert.isTrue(Result.isFailure(decoded))
    if (Result.isFailure(decoded)) assert.strictEqual(decoded.failure._tag, "SchemaError")
  })

  it("scales bigint quantities in their explicit units without restricting range", () => {
    for (const value of [0n, -2n, 2n, 10n ** 100n]) {
      assert.strictEqual(success(UnixNanos.fromSeconds(value)), value * 1_000_000_000n)
      assert.strictEqual(success(UnixNanos.fromMilliseconds(value)), value * 1_000_000n)
    }
  })

  it("interprets finite numbers using canonical decimal spelling, including exponents", () => {
    for (
      const [input, expected] of [
        [0.1, 100_000_000n],
        [-0.1, -100_000_000n],
        [1e-7, 100n],
        [1e-9, 1n],
        [-0, 0n],
        [1.23456789, 1_234_567_890n],
        [1e21, 10n ** 30n],
        [Number.MAX_VALUE, 17976931348623157n * 10n ** 301n]
      ] as const
    ) {
      assert.strictEqual(success(UnixNanos.fromSeconds(input)), expected)
    }
    assert.strictEqual(success(UnixNanos.fromMilliseconds(0.000001)), 1n)
    assert.strictEqual(success(UnixNanos.fromMilliseconds(-1.234567)), -1_234_567n)
    assert.strictEqual(success(UnixNanos.fromMilliseconds(1e21)), 10n ** 27n)
  })

  it("rejects subnanosecond remainders by default and truncates either sign toward zero", () => {
    for (
      const [convert, unit] of [
        [UnixNanos.fromSeconds, "seconds"],
        [UnixNanos.fromMilliseconds, "milliseconds"]
      ] as const
    ) {
      for (const input of [Number.MIN_VALUE, -Number.MIN_VALUE]) {
        failure(convert(input), "PrecisionLoss", "toUnixNanos", unit)
        assert.strictEqual(success(convert(input, { precision: "truncate" })), 0n)
      }
    }
    for (const sign of [-1, 1]) {
      failure(UnixNanos.fromSeconds(sign * 1.0000000009), "PrecisionLoss", "toUnixNanos", "seconds")
      assert.strictEqual(
        success(UnixNanos.fromSeconds(sign * 1.0000000009, { precision: "truncate" })),
        BigInt(sign) * 1_000_000_000n
      )
      failure(UnixNanos.fromMilliseconds(sign * 1.0000009), "PrecisionLoss", "toUnixNanos", "milliseconds")
      assert.strictEqual(
        success(UnixNanos.fromMilliseconds(sign * 1.0000009, { precision: "truncate" })),
        BigInt(sign) * 1_000_000n
      )
    }
  })

  it("translates invalid quantity inputs into safe conversion errors without coercion", () => {
    for (const input of [NaN, Infinity, -Infinity, "1", null, undefined, {}, { valueOf: () => 1 }]) {
      failure(UnixNanos.fromSeconds(input as number), "InvalidInput", "toUnixNanos", "seconds")
      failure(UnixNanos.fromMilliseconds(input as number), "InvalidInput", "toUnixNanos", "milliseconds")
    }
  })

  it("snapshots a Date once and stays independent of later mutations", () => {
    let reads = 0
    const date = new Date(123)
    date.getTime = () => {
      reads++
      return 123 + reads - 1
    }
    const value = success(UnixNanos.fromDate(date))
    assert.strictEqual(reads, 1)
    date.setTime(999)
    assert.strictEqual(value, 123_000_000n)
    failure(UnixNanos.fromDate(new Date(NaN)), "InvalidInput", "toUnixNanos", "Date")
    failure(UnixNanos.fromDate({} as Date), "InvalidInput", "toUnixNanos", "Date")
  })

  it("uses DateTime instant milliseconds regardless of zone and returns UTC", () => {
    const zoned = DateTime.makeZonedUnsafe(123, { timeZone: "Pacific/Auckland" })
    assert.strictEqual(success(UnixNanos.fromDateTime(zoned)), 123_000_000n)
    assert.strictEqual(success(UnixNanos.fromDateTime(DateTime.makeUnsafe(-123))), -123_000_000n)
    const utc = success(UnixNanos.toDateTime(nanos(123_000_000n)))
    assert.isTrue(DateTime.isUtc(utc))
    assert.strictEqual(DateTime.toEpochMillis(utc), 123)
  })

  it("rejects malformed DateTime instants before conversion", () => {
    for (const milliseconds of [NaN, Infinity, -Infinity, 0.5, 8_640_000_000_000_001, -8_640_000_000_000_001]) {
      const value = Object.assign(DateTime.makeUnsafe(0), { epochMilliseconds: milliseconds })
      failure(UnixNanos.fromDateTime(value), "InvalidInput", "toUnixNanos", "DateTime")
    }
    failure(UnixNanos.fromDateTime({} as DateTime.Utc), "InvalidInput", "toUnixNanos", "DateTime")
  })

  it("accepts both inclusive boundaries and checks original range before precision", () => {
    const bound = 8_640_000_000_000_000_000_000n
    for (const sign of [-1n, 1n]) {
      const milliseconds = Number(sign * bound / 1_000_000n)
      const boundary = nanos(sign * bound)
      assert.strictEqual(success(UnixNanos.toDate(boundary)).getTime(), milliseconds)
      assert.strictEqual(DateTime.toEpochMillis(success(UnixNanos.toDateTime(boundary))), milliseconds)
      assert.strictEqual(success(UnixNanos.fromDate(new Date(milliseconds))), boundary)
      assert.strictEqual(success(UnixNanos.fromDateTime(DateTime.makeUnsafe(milliseconds))), boundary)
    }
    for (const [convert, unit] of [[UnixNanos.toDate, "Date"], [UnixNanos.toDateTime, "DateTime"]] as const) {
      for (const sign of [-1n, 1n]) {
        const boundary = nanos(sign * bound)
        assert.isTrue(Result.isSuccess<Date | DateTime.Utc, UnixNanos.ConversionError>(convert(boundary)))
        assert.isTrue(
          Result.isSuccess<Date | DateTime.Utc, UnixNanos.ConversionError>(convert(boundary, { precision: "truncate" }))
        )
        for (const precision of ["exact", "truncate"] as const) {
          failure(convert(nanos(sign * (bound + 1n)), { precision }), "OutOfRange", "fromUnixNanos", unit)
        }
        failure(convert(nanos(sign * (bound - 1n))), "PrecisionLoss", "fromUnixNanos", unit)
        assert.isTrue(
          Result.isSuccess<Date | DateTime.Utc, UnixNanos.ConversionError>(
            convert(nanos(sign * (bound - 1n)), { precision: "truncate" })
          )
        )
      }
      failure(convert(1 as unknown as UnixNanos.UnixNanos), "InvalidInput", "fromUnixNanos", unit)
      failure(convert(nanos(-1n)), "PrecisionLoss", "fromUnixNanos", unit)
    }
    assert.strictEqual(success(UnixNanos.toDate(nanos(-1n), { precision: "truncate" })).getTime(), 0)
    assert.strictEqual(DateTime.toEpochMillis(success(UnixNanos.toDateTime(nanos(-1n), { precision: "truncate" }))), 0)
    assert.strictEqual(success(UnixNanos.toDate(nanos(-1_999_999n), { precision: "truncate" })).getTime(), -1)
  })

  it("returns fresh Dates on every successful conversion", () => {
    const value = nanos(123_000_000n)
    const first = success(UnixNanos.toDate(value))
    const second = success(UnixNanos.toDate(value))
    assert.notStrictEqual(first, second)
    first.setTime(999)
    assert.strictEqual(second.getTime(), 123)
    assert.strictEqual(value, 123_000_000n)
  })

  it("supports validated error construction, schema decoding, encoding and extension", () => {
    const fields = { reason: "PrecisionLoss", direction: "fromUnixNanos", unit: "DateTime" } as const
    assert.deepStrictEqual(success(Schema.decodeUnknownResult(UnixNanos.ConversionReason)(fields)), fields)
    const error = UnixNanos.ConversionError.make(fields)
    assert.instanceOf(error, UnixNanos.ConversionError)
    assert.strictEqual(UnixNanos.ConversionError.fields.reason, UnixNanos.ConversionReason.fields.reason)
    const encoded = Schema.encodeSync(UnixNanos.ConversionError)(error)
    const decoded = success(Schema.decodeUnknownResult(UnixNanos.ConversionError)(encoded))
    assert.instanceOf(decoded, UnixNanos.ConversionError)
    assert.strictEqual(decoded.reason, "PrecisionLoss")
    assert.throws(() => new UnixNanos.ConversionError({ ...fields, reason: "Other" as "PrecisionLoss" }))
    class DetailedError
      extends UnixNanos.ConversionError.extend<DetailedError>("DetailedError")({ detail: Schema.String })
    {}
    assert.strictEqual(new DetailedError({ ...fields, detail: "context" }).detail, "context")
  })

  it("lets unrelated defects escape instead of disguising them as conversion failures", () => {
    const defect = new Error("broken Date implementation")
    const date = new Date(0)
    date.getTime = () => {
      throw defect
    }
    const assertDefect = (run: () => unknown) => {
      try {
        run()
      } catch (error) {
        assert.strictEqual(error, defect)
        return
      }
      assert.fail("Expected the original defect to escape")
    }
    assertDefect(() => UnixNanos.fromDate(date))
    const value = DateTime.makeUnsafe(0)
    Object.defineProperty(value, "epochMilliseconds", {
      get: () => {
        throw defect
      }
    })
    assertDefect(() => UnixNanos.fromDateTime(value))
  })
})
