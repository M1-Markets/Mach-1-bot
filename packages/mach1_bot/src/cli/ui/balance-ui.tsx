import type { UserProfile } from "mach1_sdk";
import { buildTableLines, resolveViewport } from "@/cli/ui/ui-utils";

export type BalanceUiStage = "loading" | "done" | "error";

export type BalanceRow = {
  symbol: string;
  total: string;
  available: string;
  locked: string;
};

export type WalletBalanceRow = {
  label: string;
  balance: string;
};

export type BalanceUiState = {
  stage: BalanceUiStage;
  profile?: UserProfile;
  address?: string;
  balances?: BalanceRow[];
  walletBalances?: WalletBalanceRow[];
  errorMessage?: string;
  viewport?: {
    width: number;
    height: number;
  };
};

export type BalanceUiController = {
  update: (state: BalanceUiState) => void;
  unmount: () => void;
};

type InkModule = typeof import("ink");

const getStatusLabel = (stage: BalanceUiStage): string => {
  switch (stage) {
    case "loading":
      return "Loading balances";
    case "done":
      return "Completed";
    case "error":
      return "Failed";
    default:
      return "Pending";
  }
};

const makeBalanceComponent = (Ink: InkModule) => {
  const { Box, Text } = Ink;

  return ({ state, tick }: { state: BalanceUiState; tick: number }) => {
    const showProgress = state.stage === "loading";
    const progressDots = showProgress ? ".".repeat(tick) : "";
    const viewport = resolveViewport(state.viewport);

    const balances = state.balances ?? [];
    const balanceLines = buildTableLines(
      ["Symbol", "Total", "Available", "Locked"],
      balances.map((row) => [row.symbol, row.total, row.available, row.locked]),
    );
    const walletLines = buildTableLines(
      ["Token", "Balance"],
      (state.walletBalances ?? []).map((row) => [row.label, row.balance]),
    );

    return (
      <Box
        flexDirection="column"
        width={viewport.width}
        height={viewport.height}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text color="cyan">💰 Balances</Text>
        <Text color={state.stage === "error" ? "red" : "gray"}>
          {`Status: ${getStatusLabel(state.stage)}${progressDots}`}
        </Text>
        {state.errorMessage ? (
          <Text color="red">{state.errorMessage}</Text>
        ) : null}
        {state.profile ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{`ID: ${state.profile.id}`}</Text>
            <Text color="gray">{`Address: ${state.profile.address}`}</Text>
          </Box>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">Account Balances</Text>
          {balanceLines.length > 0 ? (
            balanceLines.map((line) => <Text key={`row-${line}`}>{line}</Text>)
          ) : (
            <Text color="gray">No balances found.</Text>
          )}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">Wallet Balances (On-chain)</Text>
          {walletLines.length > 0 ? (
            walletLines.map((line) => (
              <Text key={`wallet-${line}`}>{line}</Text>
            ))
          ) : (
            <Text color="gray">No wallet balances found.</Text>
          )}
        </Box>
      </Box>
    );
  };
};

export const createBalanceUi = async (
  initialState: BalanceUiState,
): Promise<BalanceUiController> => {
  const Ink = (await import("ink")) as InkModule;
  const { render } = Ink;
  const BalanceUI = makeBalanceComponent(Ink);

  let currentState = initialState;
  let tick = 0;
  let progressTimer: NodeJS.Timeout | undefined;

  const renderState = () =>
    render(<BalanceUI state={currentState} tick={tick} />);
  const instance = renderState();

  const stopProgressTimer = () => {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = undefined;
    }
    tick = 0;
  };

  const ensureProgressTimer = () => {
    if (currentState.stage !== "loading") {
      stopProgressTimer();
      return;
    }
    if (!progressTimer) {
      progressTimer = setInterval(() => {
        tick = (tick + 1) % 4;
        instance.rerender(<BalanceUI state={currentState} tick={tick} />);
      }, 250);
    }
  };

  ensureProgressTimer();

  return {
    update: (state) => {
      currentState = state;
      ensureProgressTimer();
      instance.rerender(<BalanceUI state={currentState} tick={tick} />);
    },
    unmount: () => {
      stopProgressTimer();
      instance.unmount();
    },
  };
};
