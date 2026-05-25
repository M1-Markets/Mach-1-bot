import { calculateScaledNotionalValue } from "@/shared/utils";

describe("calculateScaledNotionalValue", () => {
  it("preserves cents-style price and strategy quantity scaling", () => {
    expect(calculateScaledNotionalValue(12345n, 250n)).toBe(30862n);
  });
});
