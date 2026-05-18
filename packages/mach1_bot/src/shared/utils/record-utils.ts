export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

export const getRecord = (value: unknown): UnknownRecord | undefined =>
  isRecord(value) ? value : undefined;

export const getStringProp = (
  record: UnknownRecord | undefined,
  key: string,
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

export const getNumberProp = (
  record: UnknownRecord | undefined,
  key: string,
): number | undefined => {
  const value = record?.[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const getNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return undefined;
};
