import { buildTableLines, resolveViewport } from "@/cli/ui/ui-utils";

export type RunOrderEntry = {
  timestamp: string;
  side: "BUY" | "SELL";
  pair: string;
  amountUsd: number;
  price?: number;
  status: string;
  orderId?: string;
  reason?: string;
};

export type RunLogEntry = {
  timestamp: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  message: string;
};

export type RunUiState = {
  status: string;
  walletAddress?: string;
  mode?: string;
  strategy?: string;
  environment?: string;
  network?: string;
  orders: RunOrderEntry[];
  logs: RunLogEntry[];
  viewport?: {
    width: number;
    height: number;
  };
};

export type RunUiController = {
  update: (state: RunUiState) => void;
  addOrder: (order: RunOrderEntry) => void;
  addLog: (log: RunLogEntry) => void;
  setStatus: (status: string) => void;
  unmount: () => void;
};

type InkModule = typeof import("ink");

const formatPrice = (price?: number): string =>
  price !== undefined ? price.toFixed(4) : "-";

const formatAmount = (amountUsd: number): string => `$${amountUsd.toFixed(2)}`;

const fitTableLines = (lines: string[], maxLines: number): string[] => {
  if (maxLines <= 0) return [];
  if (lines.length <= maxLines) return lines;
  if (maxLines <= 2) return lines.slice(-maxLines);
  return [...lines.slice(0, 2), ...lines.slice(-(maxLines - 2))];
};

const makeRunComponent = (Ink: InkModule) => {
  const { Box, Text } = Ink;

  return ({ state }: { state: RunUiState }) => {
    const viewport = resolveViewport(state.viewport);
    const contentWidth = Math.max(20, viewport.width - 2);
    const orderLines = buildTableLines(
      [
        "Time",
        "Side",
        "Pair",
        "Amount",
        "Price",
        "Status",
        "Order ID",
        "Reason",
      ],
      state.orders.map((order) => [
        order.timestamp,
        order.side,
        order.pair,
        formatAmount(order.amountUsd),
        formatPrice(order.price),
        order.status,
        order.orderId ?? "-",
        order.reason ?? "-",
      ]),
      contentWidth,
    );
    const logLines = buildTableLines(
      ["Time", "Level", "Message"],
      state.logs.map((log) => [log.timestamp, log.level, log.message]),
      contentWidth,
    );

    const infoParts = [
      state.mode ? `Mode: ${state.mode}` : undefined,
      state.strategy ? `Strategy: ${state.strategy}` : undefined,
      state.environment ? `Env: ${state.environment}` : undefined,
      state.network ? `Network: ${state.network}` : undefined,
    ].filter((value): value is string => Boolean(value));

    const headerLines =
      2 + (state.walletAddress ? 1 : 0) + (infoParts.length > 0 ? 1 : 0);
    const contentHeight = Math.max(4, viewport.height - headerLines);
    const ordersHeight = Math.max(2, Math.floor(contentHeight / 2));
    const logsHeight = Math.max(2, contentHeight - ordersHeight);
    const orderContentLines = Math.max(0, ordersHeight - 1);
    const logContentLines = Math.max(0, logsHeight - 1);
    const visibleOrderLines = fitTableLines(orderLines, orderContentLines);
    const visibleLogLines = fitTableLines(logLines, logContentLines);

    return (
      <Box
        flexDirection="column"
        width={viewport.width}
        height={viewport.height}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text color="cyan">🤖 Mach-One Bot</Text>
        {state.walletAddress ? (
          <Text color="gray">{`Wallet: ${state.walletAddress}`}</Text>
        ) : null}
        <Text color="gray">{`Status: ${state.status}`}</Text>
        {infoParts.length > 0 ? (
          <Text color="gray" key="meta">
            {infoParts.join(" | ")}
          </Text>
        ) : null}
        <Box flexDirection="column" flexGrow={1}>
          <Box flexDirection="column" height={ordersHeight}>
            <Text color="cyan">Orders</Text>
            {visibleOrderLines.length > 0 ? (
              visibleOrderLines.map((line) => (
                <Text key={`order-${line}`}>{line}</Text>
              ))
            ) : (
              <Text color="gray">No orders yet.</Text>
            )}
          </Box>
          <Box flexDirection="column" height={logsHeight}>
            <Text color="cyan">Logs</Text>
            {visibleLogLines.length > 0 ? (
              visibleLogLines.map((line) => (
                <Text key={`log-${line}`}>{line}</Text>
              ))
            ) : (
              <Text color="gray">No logs yet.</Text>
            )}
          </Box>
        </Box>
      </Box>
    );
  };
};

export const createRunUi = async (
  initialState: RunUiState,
  maxOrders = 50,
  maxLogs = 200,
): Promise<RunUiController> => {
  const Ink = (await import("ink")) as InkModule;
  const { render } = Ink;
  const RunUI = makeRunComponent(Ink);

  let currentState = initialState;

  const renderState = () => render(<RunUI state={currentState} />);
  const instance = renderState();

  return {
    update: (state) => {
      currentState = state;
      instance.rerender(<RunUI state={currentState} />);
    },
    addOrder: (order) => {
      const orders = [...currentState.orders, order].slice(-maxOrders);
      currentState = { ...currentState, orders };
      instance.rerender(<RunUI state={currentState} />);
    },
    addLog: (log) => {
      const logs = [...currentState.logs, log].slice(-maxLogs);
      currentState = { ...currentState, logs };
      instance.rerender(<RunUI state={currentState} />);
    },
    setStatus: (status) => {
      currentState = { ...currentState, status };
      instance.rerender(<RunUI state={currentState} />);
    },
    unmount: () => {
      instance.unmount();
    },
  };
};
