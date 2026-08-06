/**
 * Prisma returns money as JS `bigint` (Postgres BIGINT poisha). JSON has no
 * bigint, so we serialise to an integer JSON number — still no float anywhere.
 * Anything beyond 2^53 poisha (≈ 90 trillion BDT) is a bug, so it throws loudly
 * rather than silently losing precision.
 */
export function installBigIntJson(): void {
  const proto = BigInt.prototype as unknown as { toJSON?: () => number };
  if (proto.toJSON) return;
  proto.toJSON = function toJSON(this: bigint): number {
    const asNumber = Number(this);
    if (!Number.isSafeInteger(asNumber)) {
      throw new RangeError(`Money value ${this.toString()} exceeds safe JSON integer range`);
    }
    return asNumber;
  };
}

/** Convert bigint fields to numbers for code paths that build plain objects. */
export function minorToNumber(value: bigint): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError(`Money value ${value.toString()} exceeds safe integer range`);
  }
  return asNumber;
}
