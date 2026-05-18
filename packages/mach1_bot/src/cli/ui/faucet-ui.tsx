import type { ReactElement } from "react";
import { buildTableLines } from "@/cli/ui/ui-utils";

export type FaucetUiStage = "requesting" | "processing" | "done" | "error";

export type FaucetMintedToken = {
  symbol: string;
  amount: string;
  assetId: string;
  txHash: string;
};

export type FaucetFailedToken = {
  symbol: string;
  assetId: string;
  error: string;
};

export type FaucetUiState = {
  stage: FaucetUiStage;
  endpoint?: string;
  remainingRequests?: number;
  minted?: FaucetMintedToken[];
  failed?: FaucetFailedToken[];
  errorMessage?: string;
};

export type FaucetUiController = {
  update: (state: FaucetUiState) => void;
  unmount: () => void;
};

type InkModule = typeof import("ink");

type FaucetUiProps = {
  state: FaucetUiState;
  tick: number;
};

const getStatusLabel = (stage: FaucetUiStage): string => {
  switch (stage) {
    case "requesting":
      return "Requesting faucet";
    case "processing":
      return "Processing response";
    case "done":
      return "Completed";
    case "error":
      return "Failed";
    default:
      return "Pending";
  }
};

const makeFaucetComponent = (Ink: InkModule) => {
  const { Box, Text } = Ink;

  return ({ state, tick }: FaucetUiProps): ReactElement => {
    const showProgress =
      state.stage === "requesting" || state.stage === "processing";
    const progressDots = showProgress ? ".".repeat(tick) : "";

    const mintedRows = (state.minted ?? []).map((entry) => [
      entry.symbol,
      entry.amount,
      entry.assetId,
      entry.txHash,
    ]);
    const failedRows = (state.failed ?? []).map((entry) => [
      entry.symbol,
      entry.assetId,
      entry.error,
    ]);
    const mintedLines = buildTableLines(
      ["Symbol", "Amount", "Asset ID", "Tx Hash"],
      mintedRows,
    );
    const failedLines = buildTableLines(
      ["Symbol", "Asset ID", "Error"],
      failedRows,
    );

    return (
      <Box flexDirection="column">
        <Text color="cyan">🚰 Faucet</Text>
        <Text color={state.stage === "error" ? "red" : "gray"}>
          {`Status: ${getStatusLabel(state.stage)}${progressDots}`}
        </Text>
        {state.endpoint ? (
          <Text color="gray">{`Endpoint: ${state.endpoint}`}</Text>
        ) : null}
        {state.remainingRequests !== undefined ? (
          <Text color="gray">
            {`Remaining requests (24h): ${state.remainingRequests}`}
          </Text>
        ) : null}
        {state.errorMessage ? (
          <Text color="red">{state.errorMessage}</Text>
        ) : null}
        {mintedLines.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="green">Minted Tokens</Text>
            {mintedLines.map((line) => (
              <Text key={`minted-${line}`}>{line}</Text>
            ))}
          </Box>
        ) : null}
        {failedLines.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">Failed Mints</Text>
            {failedLines.map((line) => (
              <Text key={`failed-${line}`}>{line}</Text>
            ))}
          </Box>
        ) : null}
      </Box>
    );
  };
};

export const createFaucetUi = async (
  initialState: FaucetUiState,
): Promise<FaucetUiController> => {
  const Ink = (await import("ink")) as InkModule;
  const { render } = Ink;
  const FaucetUI = makeFaucetComponent(Ink);

  let currentState = initialState;
  let tick = 0;
  let progressTimer: NodeJS.Timeout | undefined;

  const renderState = () =>
    render(<FaucetUI state={currentState} tick={tick} />);
  const instance = renderState();

  const stopProgressTimer = () => {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = undefined;
    }
    tick = 0;
  };

  const ensureProgressTimer = () => {
    const shouldTick =
      currentState.stage === "requesting" ||
      currentState.stage === "processing";
    if (!shouldTick) {
      stopProgressTimer();
      return;
    }

    if (!progressTimer) {
      progressTimer = setInterval(() => {
        tick = (tick + 1) % 4;
        instance.rerender(<FaucetUI state={currentState} tick={tick} />);
      }, 250);
    }
  };

  ensureProgressTimer();

  return {
    update: (state) => {
      currentState = state;
      ensureProgressTimer();
      instance.rerender(<FaucetUI state={currentState} tick={tick} />);
    },
    unmount: () => {
      stopProgressTimer();
      instance.unmount();
    },
  };
};
