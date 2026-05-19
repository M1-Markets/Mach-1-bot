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

const fitLine = (value: string, width: number): string => {
  if (width <= 0) return "";
  if (value.length > width) return value.slice(0, width);
  return value.padEnd(width);
};

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
    const contentWidth = Math.max(20, viewport.width - 6);
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

    const walletLine = state.walletAddress
      ? `WALLET ${state.walletAddress}`
      : "WALLET not connected";
    const metaLine =
      infoParts.length > 0 ? infoParts.join(" | ") : "Mode: - | Strategy: -";
    const chromeHeight = 7;
    const contentHeight = Math.max(4, viewport.height - chromeHeight);
    const ordersHeight = Math.max(3, Math.floor(contentHeight / 2));
    const logsHeight = Math.max(3, contentHeight - ordersHeight);
    const orderContentLines = Math.max(0, ordersHeight - 3);
    const logContentLines = Math.max(0, logsHeight - 3);
    const visibleOrderLines = fitTableLines(orderLines, orderContentLines);
    const visibleLogLines = fitTableLines(logLines, logContentLines);
    const statusBar = fitLine(
      ` MACH-ONE BOT // ${state.status.toUpperCase()}`,
      viewport.width,
    );
    const footer = fitLine(
      ` ORDERS ${state.orders.length} | LOGS ${state.logs.length} | CTRL-C EXIT`,
      viewport.width,
    );

    return (
      <Box
        flexDirection="column"
        width={viewport.width}
        height={viewport.height}
      >
        <Text color="black" backgroundColor="cyan">
          {statusBar}
        </Text>
        <Box
          borderStyle="single"
          borderColor="cyan"
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
        >
          <Text color="green">{fitLine(walletLine, contentWidth)}</Text>
          <Text color="green">
            {fitLine(`STATUS ${state.status}`, contentWidth)}
          </Text>
          <Text color="green">{fitLine(metaLine, contentWidth)}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Box
            borderStyle="single"
            borderColor="green"
            flexDirection="column"
            height={ordersHeight}
            paddingLeft={1}
            paddingRight={1}
          >
            <Text color="cyan" bold>
              ORDERS
            </Text>
            {visibleOrderLines.length > 0 ? (
              visibleOrderLines.map((line) => (
                <Text color="green" key={`order-${line}`}>
                  {line}
                </Text>
              ))
            ) : (
              <Text color="gray">[empty] No orders yet.</Text>
            )}
          </Box>
          <Box
            borderStyle="single"
            borderColor="green"
            flexDirection="column"
            height={logsHeight}
            paddingLeft={1}
            paddingRight={1}
          >
            <Text color="cyan" bold>
              LOGS
            </Text>
            {visibleLogLines.length > 0 ? (
              visibleLogLines.map((line) => (
                <Text color="green" key={`log-${line}`}>
                  {line}
                </Text>
              ))
            ) : (
              <Text color="gray">[empty] No logs yet.</Text>
            )}
          </Box>
        </Box>
        <Text color="black" backgroundColor="green">
          {footer}
        </Text>
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
