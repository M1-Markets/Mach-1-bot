import { useMemo, useState } from "react";
import {
  buildTableLines,
  isValidAmount,
  resolveTokenOption,
  resolveViewport,
  type TokenOption,
} from "@/cli/ui/ui-utils";

export type SwapUiStage =
  | "input"
  | "preparing"
  | "executing"
  | "done"
  | "error";

export type SwapUiState = {
  stage: SwapUiStage;
  inputToken: string;
  outputToken: string;
  amount: string;
  vaultBalance: string;
  route?: string;
  estimatedOutput?: string;
  currentLeg?: number;
  totalLegs?: number;
  status?: string;
  errorMessage?: string;
  viewport?: {
    width: number;
    height: number;
  };
};

export type SwapUiController = {
  update: (state: SwapUiState) => void;
  unmount: () => void;
};

export type SwapTokenOption = TokenOption;

export type SwapInputResult = {
  inputToken: string;
  outputToken: string;
  amountInput: string;
};

type InkModule = typeof import("ink");
type InkTextInputModule = typeof import("ink-text-input");
type InkTextInputComponent = InkTextInputModule["default"];

type SwapUiProps = {
  state: SwapUiState;
  tick: number;
};

type SwapInputProps = {
  tokenOptions: SwapTokenOption[];
  initialInput?: string;
  initialOutput?: string;
  initialAmount?: string;
  viewport?: {
    width: number;
    height: number;
  };
  onSubmit: (result: SwapInputResult) => void;
};

type SwapConfirmProps = {
  summary: string;
  viewport?: {
    width: number;
    height: number;
  };
  onSubmit: (confirm: boolean) => void;
};

const getStatusLabel = (stage: SwapUiStage): string => {
  switch (stage) {
    case "input":
      return "Waiting for input";
    case "preparing":
      return "Preparing swap";
    case "executing":
      return "Executing swap";
    case "done":
      return "Completed";
    case "error":
      return "Failed";
    default:
      return "Pending";
  }
};

const makeSwapComponent = (Ink: InkModule) => {
  const { Box, Text } = Ink;

  return ({ state, tick }: SwapUiProps) => {
    const showProgress =
      state.stage === "preparing" || state.stage === "executing";
    const progressDots = showProgress ? ".".repeat(tick) : "";
    const viewport = resolveViewport(state.viewport);

    const rows: string[][] = [
      ["Input", state.inputToken],
      ["Output", state.outputToken],
      ["Amount", state.amount],
      ["Vault Balance", state.vaultBalance],
      ["Route", state.route ?? "-"],
      ["Estimated Output", state.estimatedOutput ?? "-"],
      [
        "Leg",
        state.currentLeg && state.totalLegs
          ? `${state.currentLeg}/${state.totalLegs}`
          : "-",
      ],
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
        <Text color="cyan">🔁 Swap</Text>
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

const makeSwapInputComponent = (
  Ink: InkModule,
  TextInput: InkTextInputComponent,
) => {
  const { Box, Text } = Ink;

  return ({
    tokenOptions,
    initialInput,
    initialOutput,
    initialAmount,
    viewport,
    onSubmit,
  }: SwapInputProps) => {
    const [step, setStep] = useState<"input" | "output" | "amount">("input");
    const [inputValue, setInputValue] = useState(initialInput ?? "");
    const [outputValue, setOutputValue] = useState(initialOutput ?? "");
    const [amountValue, setAmountValue] = useState(initialAmount ?? "");
    const [errorMessage, setErrorMessage] = useState<string | undefined>();

    const inputOption = useMemo(
      () => resolveTokenOption(inputValue, tokenOptions),
      [inputValue, tokenOptions],
    );
    const outputOption = useMemo(
      () => resolveTokenOption(outputValue, tokenOptions),
      [outputValue, tokenOptions],
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
        ["#", "Symbol", "Asset ID", "Vault Balance"],
        rows,
      );
    }, [tokenOptions]);

    const handleInputSubmit = () => {
      const trimmed = inputValue.trim();
      if (!trimmed) {
        setErrorMessage("Input token is required.");
        return;
      }
      setErrorMessage(undefined);
      setStep("output");
    };

    const handleOutputSubmit = () => {
      const trimmed = outputValue.trim();
      if (!trimmed) {
        setErrorMessage("Output token is required.");
        return;
      }
      if (
        inputOption &&
        outputOption &&
        inputOption.address.toLowerCase() === outputOption.address.toLowerCase()
      ) {
        setErrorMessage("Input and output tokens must be different.");
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
      onSubmit({
        inputToken: inputValue.trim(),
        outputToken: outputValue.trim(),
        amountInput: trimmed,
      });
    };

    return (
      <Box
        flexDirection="column"
        width={viewportSize.width}
        height={viewportSize.height}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text color="cyan">🔁 Swap</Text>
        <Text color="gray">
          {step === "input"
            ? "Enter input token (number, symbol, asset id, or address)"
            : step === "output"
              ? "Enter output token (number, symbol, asset id, or address)"
              : "Enter amount to swap"}
        </Text>
        {errorMessage ? <Text color="red">{errorMessage}</Text> : null}
        {step !== "amount" ? (
          <Box marginTop={1} flexDirection="column">
            {tableLines.map((line) => (
              <Text key={`token-${line}`}>{line}</Text>
            ))}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color="green">
            {step === "input"
              ? "Input: "
              : step === "output"
                ? "Output: "
                : "Amount: "}
          </Text>
          <TextInput
            value={
              step === "input"
                ? inputValue
                : step === "output"
                  ? outputValue
                  : amountValue
            }
            onChange={
              step === "input"
                ? setInputValue
                : step === "output"
                  ? setOutputValue
                  : setAmountValue
            }
            onSubmit={
              step === "input"
                ? handleInputSubmit
                : step === "output"
                  ? handleOutputSubmit
                  : handleAmountSubmit
            }
            focus
          />
        </Box>
        {step === "amount" ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">
              {inputOption && outputOption
                ? `Selected: ${inputOption.symbol} → ${outputOption.symbol}`
                : "Selected: -"}
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

const makeSwapConfirmComponent = (
  Ink: InkModule,
  TextInput: InkTextInputComponent,
) => {
  const { Box, Text } = Ink;

  return ({ summary, viewport, onSubmit }: SwapConfirmProps) => {
    const [value, setValue] = useState("");
    const [errorMessage, setErrorMessage] = useState<string | undefined>();
    const viewportSize = resolveViewport(viewport);

    const handleSubmit = () => {
      const trimmed = value.trim().toLowerCase();
      if (!trimmed) {
        setErrorMessage("Enter y or n.");
        return;
      }
      if (trimmed !== "y" && trimmed !== "n") {
        setErrorMessage("Enter y or n.");
        return;
      }
      setErrorMessage(undefined);
      onSubmit(trimmed === "y");
    };

    return (
      <Box
        flexDirection="column"
        width={viewportSize.width}
        height={viewportSize.height}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text color="cyan">🔁 Swap Confirmation</Text>
        <Text color="gray">{summary}</Text>
        {errorMessage ? <Text color="red">{errorMessage}</Text> : null}
        <Box marginTop={1}>
          <Text color="green">Confirm (y/n): </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
          />
        </Box>
      </Box>
    );
  };
};

export const createSwapUi = async (
  initialState: SwapUiState,
): Promise<SwapUiController> => {
  const Ink = (await import("ink")) as InkModule;
  const { render } = Ink;
  const SwapUI = makeSwapComponent(Ink);

  let currentState = initialState;
  let tick = 0;
  let progressTimer: NodeJS.Timeout | undefined;

  const renderState = () => render(<SwapUI state={currentState} tick={tick} />);
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
      currentState.stage === "preparing" || currentState.stage === "executing";
    if (!shouldTick) {
      stopProgressTimer();
      return;
    }

    if (!progressTimer) {
      progressTimer = setInterval(() => {
        tick = (tick + 1) % 4;
        instance.rerender(<SwapUI state={currentState} tick={tick} />);
      }, 250);
    }
  };

  ensureProgressTimer();

  return {
    update: (state) => {
      currentState = state;
      ensureProgressTimer();
      instance.rerender(<SwapUI state={currentState} tick={tick} />);
    },
    unmount: () => {
      stopProgressTimer();
      instance.unmount();
    },
  };
};

export const promptForSwapInput = async (
  options: Omit<SwapInputProps, "onSubmit">,
): Promise<SwapInputResult> => {
  const Ink = (await import("ink")) as InkModule;
  const TextInputModule = (await import(
    "ink-text-input"
  )) as InkTextInputModule;
  const { render } = Ink;
  const TextInput = TextInputModule.default as InkTextInputComponent;
  const SwapInputUI = makeSwapInputComponent(Ink, TextInput);

  return await new Promise<SwapInputResult>((resolve) => {
    const instance = render(
      <SwapInputUI
        tokenOptions={options.tokenOptions}
        initialInput={options.initialInput}
        initialOutput={options.initialOutput}
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

export const promptForSwapConfirmation = async (
  summary: string,
  viewport?: { width: number; height: number },
): Promise<boolean> => {
  const Ink = (await import("ink")) as InkModule;
  const TextInputModule = (await import(
    "ink-text-input"
  )) as InkTextInputModule;
  const { render } = Ink;
  const TextInput = TextInputModule.default as InkTextInputComponent;
  const SwapConfirmUI = makeSwapConfirmComponent(Ink, TextInput);

  return await new Promise<boolean>((resolve) => {
    const instance = render(
      <SwapConfirmUI
        summary={summary}
        viewport={viewport}
        onSubmit={(confirm) => {
          instance.unmount();
          resolve(confirm);
        }}
      />,
    );
  });
};
