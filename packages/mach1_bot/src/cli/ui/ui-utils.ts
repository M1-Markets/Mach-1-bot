export type UiViewport = {
  width: number;
  height: number;
};

export type TokenOption = {
  symbol: string;
  assetId: string;
  address: `0x${string}`;
  balance: string;
};

const clampWidthsToMax = (widths: number[], maxWidth: number): number[] => {
  const columnCount = widths.length;
  if (columnCount === 0) return widths;
  const separatorWidth = columnCount > 1 ? (columnCount - 1) * 3 : 0;
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  if (totalWidth + separatorWidth <= maxWidth) return widths;

  const adjusted = [...widths];
  let overflow = totalWidth + separatorWidth - maxWidth;
  let index = columnCount - 1;
  while (overflow > 0 && index >= 0) {
    const reducible = Math.max(0, adjusted[index] - 1);
    if (reducible > 0) {
      const delta = Math.min(reducible, overflow);
      adjusted[index] -= delta;
      overflow -= delta;
    }
    index -= 1;
    if (index < 0 && overflow > 0) {
      index = columnCount - 1;
    }
  }

  return adjusted;
};

const truncateCell = (value: string, width: number): string => {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return value.slice(0, 1);
  return `${value.slice(0, width - 1)}…`;
};

export const buildTableLines = (
  headers: string[],
  rows: string[][],
  maxWidth?: number,
): string[] => {
  if (rows.length === 0) {
    return [];
  }

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const safeWidths =
    typeof maxWidth === "number" && maxWidth > 0
      ? clampWidthsToMax(widths, maxWidth)
      : widths;

  const formatRow = (cells: string[]) =>
    cells
      .map((cell, index) =>
        truncateCell(cell, safeWidths[index]).padEnd(safeWidths[index]),
      )
      .join(" | ");
  const separator = safeWidths.map((width) => "-".repeat(width)).join("-+-");

  return [formatRow(headers), separator, ...rows.map((row) => formatRow(row))];
};

export const resolveViewport = (
  viewport?: Partial<UiViewport>,
): UiViewport => ({
  width: Math.max(40, viewport?.width ?? process.stdout.columns ?? 80),
  height: Math.max(12, viewport?.height ?? process.stdout.rows ?? 24),
});

export const resolveTokenOption = (
  input: string,
  options: TokenOption[],
): TokenOption | undefined => {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const parsedIndex = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(parsedIndex) && parsedIndex > 0) {
    return options[parsedIndex - 1];
  }

  const normalized = trimmed.toLowerCase();
  return options.find(
    (option) =>
      option.symbol.toLowerCase() === normalized ||
      option.assetId.toLowerCase() === normalized ||
      option.address.toLowerCase() === normalized,
  );
};

export const isValidAmount = (value: string): boolean => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
};
