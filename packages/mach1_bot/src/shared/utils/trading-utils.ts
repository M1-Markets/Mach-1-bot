/**
 * Convert quote price scaled by 100 and base quantity scaled by 100 into
 * quote-currency notional scaled by 100.
 */
export function calculateScaledNotionalValue(
  price: bigint,
  quantity: bigint,
): bigint {
  return (price * quantity) / 100n;
}
