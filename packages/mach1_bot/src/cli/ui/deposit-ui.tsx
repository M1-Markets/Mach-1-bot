import { useMemo, useState } from "react";
import {
  buildTableLines,
  isValidAmount,
  resolveTokenOption,
  resolveViewport,
  type TokenOption,
} from "@/cli/ui/ui-utils";

export type DepositUiStage =
  | "input"
  | "preparing"
  | "approving"
  | "depositing"
  | "done"
  | "error";

export type DepositUiState = {
  stage: DepositUiStage;
  token: string;
  amount: string;
  walletBalance: string;
  approvalTxHash?: string;
  approvalTxUrl?: string;
  depositTxHash?: string;
  depositTxUrl?: string;
  status?: string;
  errorMessage?: string;
  viewport?: {
    width: number;
    height: number;
  };
};

export type DepositUiController = {
  update: (state: DepositUiState) => void;
  unmount: () => void;
};

type InkModule = typeof import("ink");
type InkTextInputModule = typeof import("ink-text-input");
type InkTextInputComponent = InkTextInputModule["default"];

type DepositUiProps = {
  state: DepositUiState;
  tick: number;
};

const getStatusLabel = (stage: DepositUiStage): string => {
  switch (stage) {
    case "input":
      return "Waiting for input";
    case "preparing":
      return "Preparing deposit";
    case "approving":
      return "Approving allowance";
    case "depositing":
      return "Submitting deposit";
    case "done":
      return "Completed";
    case "error":
      return "Failed";
    default:
      return "Pending";
  }
};

const makeDepositComponent = (Ink: InkModule) => {
  const { Box, Text } = Ink;

  return ({ state, tick }: DepositUiProps) => {
    const showProgress =
      state.stage === "preparing" ||
      state.stage === "approving" ||
      state.stage === "depositing";
    const progressDots = showProgress ? ".".repeat(tick) : "";
    const viewport = resolveViewport(state.viewport);

    const rows: string[][] = [
      ["Token", state.token],
      ["Amount", state.amount],
      ["Wallet Balance", state.walletBalance],
      ["Approval Tx", state.approvalTxHash ?? "-"],
      ["Approval Url", state.approvalTxUrl ?? "-"],
      ["Deposit Tx", state.depositTxHash ?? "-"],
      ["Deposit Url", state.depositTxUrl ?? "-"],
      ["Status", state.status ?? "-"],
    ];

    const tableLines = buildTableLines(["Field", "Value"], rows);

    return (
      <Box
        flexDirection="column"
        width={viewport.width}
        height={viewport.height}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text color="cyan">📥 Deposit</Text>
        <Text color={state.stage === "error" ? "red" : "gray"}>
          {`Status: ${getStatusLabel(state.stage)}${progressDots}`}
        </Text>
        {state.errorMessage ? (
          <Text color="red">{state.errorMessage}</Text>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          {tableLines.map((line) => (
            <Text key={`row-${line}`}>{line}</Text>
          ))}
        </Box>
      </Box>
    );
  };
};

export type DepositTokenOption = TokenOption;

export type DepositInputResult = {
  tokenInput: string;
  amountInput: string;
};

type DepositInputProps = {
  tokenOptions: DepositTokenOption[];
  initialToken?: string;
  initialAmount?: string;
  viewport?: {
    width: number;
    height: number;
  };
  onSubmit: (result: DepositInputResult) => void;
};

const makeDepositInputComponent = (
  Ink: InkModule,
  TextInput: InkTextInputComponent,
) => {
  const { Box, Text } = Ink;

  return ({
    tokenOptions,
    initialToken,
    initialAmount,
    viewport,
    onSubmit,
  }: DepositInputProps) => {
    const [step, setStep] = useState<"token" | "amount">("token");
    const [tokenValue, setTokenValue] = useState(initialToken ?? "");
    const [amountValue, setAmountValue] = useState(initialAmount ?? "");
    const [errorMessage, setErrorMessage] = useState<string | undefined>();

    const selectedOption = useMemo(
      () => resolveTokenOption(tokenValue, tokenOptions),
      [tokenValue, tokenOptions],
    );

    const viewportSize = resolveViewport(viewport);

    const tableLines = useMemo(() => {
      const rows = tokenOptions.map((option, index) => [
        String(index + 1),
        option.symbol,
        option.assetId,
        option.balance,
      ]);
      return buildTableLines(
        ["#", "Symbol", "Asset ID", "Wallet Balance"],
        rows,
      );
    }, [tokenOptions]);

    const handleTokenSubmit = () => {
      const trimmed = tokenValue.trim();
      if (!trimmed) {
        setErrorMessage("Token selection is required.");
        return;
      }
      const normalized = trimmed.toLowerCase();
      if (normalized === "all" || trimmed === "*") {
        setErrorMessage(undefined);
        onSubmit({ tokenInput: trimmed, amountInput: "all" });
        return;
      }
      setErrorMessage(undefined);
      setStep("amount");
    };

    const handleAmountSubmit = () => {
      const trimmed = amountValue.trim();
      if (!trimmed) {
        setErrorMessage("Amount is required.");
        return;
      }
      if (!isValidAmount(trimmed)) {
        setErrorMessage("Amount must be a positive number.");
        return;
      }
      setErrorMessage(undefined);
      onSubmit({ tokenInput: tokenValue.trim(), amountInput: trimmed });
    };

    return (
      <Box
        flexDirection="column"
        width={viewportSize.width}
        height={viewportSize.height}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text color="cyan">📥 Deposit</Text>
        <Text color="gray">
          {step === "token"
            ? "Enter token (number, symbol, asset id, address, or 'all')"
            : "Enter amount to deposit"}
        </Text>
        {errorMessage ? <Text color="red">{errorMessage}</Text> : null}
        {step === "token" ? (
          <Box marginTop={1} flexDirection="column">
            {tableLines.map((line) => (
              <Text key={`token-${line}`}>{line}</Text>
            ))}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color="green">{step === "token" ? "Token: " : "Amount: "}</Text>
          <TextInput
            value={step === "token" ? tokenValue : amountValue}
            onChange={step === "token" ? setTokenValue : setAmountValue}
            onSubmit={step === "token" ? handleTokenSubmit : handleAmountSubmit}
            focus
          />
        </Box>
        {step === "amount" ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">
              {selectedOption
                ? `Selected: ${selectedOption.symbol} (balance ${selectedOption.balance})`
                : `Selected: ${tokenValue.trim() || "-"}`}
            </Text>
            <Text color="gray">
              Press Enter to submit. Press Ctrl+C to cancel.
            </Text>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color="gray">Press Enter to continue.</Text>
          </Box>
        )}
      </Box>
    );
  };
};

export const promptForDepositInput = async (
  options: Omit<DepositInputProps, "onSubmit">,
): Promise<DepositInputResult> => {
  const Ink = (await import("ink")) as InkModule;
  const TextInputModule = (await import(
    "ink-text-input"
  )) as InkTextInputModule;
  const { render } = Ink;
  const TextInput = TextInputModule.default as InkTextInputComponent;
  const DepositInputUI = makeDepositInputComponent(Ink, TextInput);

  return await new Promise<DepositInputResult>((resolve) => {
    const instance = render(
      <DepositInputUI
        tokenOptions={options.tokenOptions}
        initialToken={options.initialToken}
        initialAmount={options.initialAmount}
        viewport={options.viewport}
        onSubmit={(result) => {
          instance.unmount();
          resolve(result);
        }}
      />,
    );
  });
};

export const createDepositUi = async (
  initialState: DepositUiState,
): Promise<DepositUiController> => {
  const Ink = (await import("ink")) as InkModule;
  const { render } = Ink;
  const DepositUI = makeDepositComponent(Ink);

  let currentState = initialState;
  let tick = 0;
  let progressTimer: NodeJS.Timeout | undefined;

  const renderState = () =>
    render(<DepositUI state={currentState} tick={tick} />);
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
      currentState.stage === "preparing" ||
      currentState.stage === "approving" ||
      currentState.stage === "depositing";
    if (!shouldTick) {
      stopProgressTimer();
      return;
    }

    if (!progressTimer) {
      progressTimer = setInterval(() => {
        tick = (tick + 1) % 4;
        instance.rerender(<DepositUI state={currentState} tick={tick} />);
      }, 250);
    }
  };

  ensureProgressTimer();

  return {
    update: (state) => {
      currentState = state;
      ensureProgressTimer();
      instance.rerender(<DepositUI state={currentState} tick={tick} />);
    },
    unmount: () => {
      stopProgressTimer();
      instance.unmount();
    },
  };
};
