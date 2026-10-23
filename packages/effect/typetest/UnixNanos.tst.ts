import type * as DateTime from "effect/DateTime"
import type * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as UnixNanos from "effect/UnixNanos"
import { describe, expect, it } from "tstyche"

describe("UnixNanos", () => {
  it("brands bigint without allowing raw bigint consumers or implicit units", () => {
    const value = UnixNanos.fromNanoseconds(1n)
    expect(value).type.toBe<UnixNanos.UnixNanos>()
    expect(value).type.toBeAssignableTo<bigint>()
    expect<bigint>().type.not.toBeAssignableTo<UnixNanos.UnixNanos>()
    expect(UnixNanos.toNanoseconds(value)).type.toBe<bigint>()
    // @ts-expect-error is not assignable to
    UnixNanos.fromNanoseconds(1)
    // @ts-expect-error is not assignable to
    UnixNanos.fromSeconds("1")
    // @ts-expect-error is not assignable to
    UnixNanos.fromMilliseconds("1")
    // @ts-expect-error is not assignable to
    UnixNanos.toDate(1n)
    // @ts-expect-error is not assignable to
    UnixNanos.fromSeconds(1, { precision: "round" })
  })

  it("preserves the decoded brand and UTC output contract", () => {
    expect(Schema.decodeUnknownResult(UnixNanos.UnixNanos)(1n)).type.toBe<
      Result.Result<UnixNanos.UnixNanos, Schema.SchemaError>
    >()
    expect(UnixNanos.toDateTime(UnixNanos.fromNanoseconds(0n))).type.toBe<
      Result.Result<DateTime.Utc, UnixNanos.ConversionError>
    >()
  })

  it("exposes schema-backed error fields, construction and extension", () => {
    const fields = { reason: "InvalidInput", direction: "toUnixNanos", unit: "seconds" } as const
    expect(UnixNanos.ConversionError.make(fields)).type.toBe<UnixNanos.ConversionError>()
    expect(Schema.decodeUnknownResult(UnixNanos.ConversionError)({})).type.toBe<
      Result.Result<UnixNanos.ConversionError, Schema.SchemaError>
    >()
    expect<UnixNanos.ConversionReason["reason"]>().type.toBe<"InvalidInput" | "OutOfRange" | "PrecisionLoss">()
    expect(UnixNanos.ConversionError.fields.reason).type.toBe<typeof UnixNanos.ConversionReason.fields.reason>()
    class DetailedError
      extends UnixNanos.ConversionError.extend<DetailedError>("DetailedError")({ detail: Schema.String })
    {}
    expect(new DetailedError({ ...fields, detail: "context" }).detail).type.toBe<string>()
    // @ts-expect-error is not assignable to
    const invalid = new UnixNanos.ConversionError({ ...fields, unit: "minutes" })
    expect(invalid).type.toBe<UnixNanos.ConversionError>()
  })
})
