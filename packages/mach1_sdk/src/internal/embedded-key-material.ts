const EMBEDDED_KEY_MATERIAL_PAYLOAD = {
  encodedTokensReversed: [
    "67",
    "5y",
    "3e",
    "y",
    "59",
    "1t",
    "25",
    "l",
    "2e",
    "n",
    "37",
    "o",
    "9",
    "d",
    "ec",
    "33",
    "46",
    "1c",
    "47",
    "6e",
    "ce",
    "1a",
    "e5",
    "m",
    "7d",
    "10",
    "71",
    "35",
    "52",
    "2y",
    "4a",
    "3b",
  ] as const,
  permutationMaskTrace: [
    59, 45, 41, 49, 41, 72, 87, 42, 33, 46, 60, 45, 74, 84, 43, 57, 57, 39, 56,
    91, 75, 58, 52, 62, 44, 58, 81, 68, 51, 40, 32, 54,
  ] as const,
  checksumHex: "134f4126",
  expectedLength: 32,
} as const;

function decodePermutation(trace: readonly number[]): number[] {
  return trace.map((value, index) => value ^ (0x2a + (index % 7) * 5));
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

function decodeEmbeddedKeyMaterial(): string {
  const encodedParts = [
    ...EMBEDDED_KEY_MATERIAL_PAYLOAD.encodedTokensReversed,
  ].reverse();
  const permutation = decodePermutation(
    EMBEDDED_KEY_MATERIAL_PAYLOAD.permutationMaskTrace,
  );

  if (encodedParts.length !== EMBEDDED_KEY_MATERIAL_PAYLOAD.expectedLength) {
    throw new Error("Invalid embedded payload length.");
  }

  const chars = new Array<string>(EMBEDDED_KEY_MATERIAL_PAYLOAD.expectedLength);

  for (
    let encodedIndex = 0;
    encodedIndex < encodedParts.length;
    encodedIndex += 1
  ) {
    const part = encodedParts[encodedIndex];
    const radix = encodedIndex % 2 === 0 ? 36 : 16;
    const encodedValue = Number.parseInt(part, radix);

    if (!Number.isFinite(encodedValue)) {
      throw new Error("Invalid embedded payload segment.");
    }

    const originalIndex = permutation[encodedIndex];
    const unmasked = encodedValue ^ (0x5a + (encodedIndex % 5) * 3);
    const unshifted = unmasked - ((originalIndex % 7) + 1) * 5;
    const charCode = unshifted ^ (0x21 + ((originalIndex * 13) % 71));

    if (
      !Number.isInteger(charCode) ||
      charCode < 48 ||
      charCode > 102 ||
      (charCode > 57 && charCode < 97)
    ) {
      throw new Error("Decoded payload failed validation.");
    }

    chars[originalIndex] = String.fromCharCode(charCode);
  }

  const embeddedValue = chars.join("");

  if (
    embeddedValue.length !== EMBEDDED_KEY_MATERIAL_PAYLOAD.expectedLength ||
    !/^[a-f0-9]{32}$/.test(embeddedValue)
  ) {
    throw new Error("Decoded payload format is invalid.");
  }

  if (fnv1aHex(embeddedValue) !== EMBEDDED_KEY_MATERIAL_PAYLOAD.checksumHex) {
    throw new Error("Decoded payload checksum mismatch.");
  }

  return embeddedValue;
}

export const EMBEDDED_KEY_MATERIAL = decodeEmbeddedKeyMaterial();
