import { resolveViewport } from "@/cli/ui/ui-utils";

export type SupervisorPaneState = {
  id: string;
  title: string;
  status?: string;
  lines: string[];
};

export type SupervisorUiState = {
  status: string;
  panes: SupervisorPaneState[];
  viewport?: {
    width: number;
    height: number;
  };
};

export type SupervisorUiController = {
  appendLine: (paneId: string, line: string) => void;
  setPaneStatus: (paneId: string, status: string) => void;
  setStatus: (status: string) => void;
  unmount: () => void;
};

type InkModule = typeof import("ink");

const fitLines = (lines: string[], maxLines: number): string[] => {
  if (maxLines <= 0) return [];
  if (lines.length <= maxLines) return lines;
  return lines.slice(-maxLines);
};

const makeSupervisorComponent = (Ink: InkModule) => {
  const { Box, Text } = Ink;

  return ({ state }: { state: SupervisorUiState }) => {
    const viewport = resolveViewport(state.viewport);
    const maxPanes = 2;
    const visiblePanes = state.panes.slice(0, maxPanes);
    const hiddenCount = Math.max(0, state.panes.length - maxPanes);
    const headerStatus =
      hiddenCount > 0
        ? `${state.status} (+${hiddenCount} hidden)`
        : state.status;
    const headerLines = 2;
    const contentHeight = Math.max(1, viewport.height - headerLines);
    const paneCount = Math.max(1, visiblePanes.length);
    const paneHeight = Math.max(3, Math.floor(contentHeight / paneCount));

    return (
      <Box
        flexDirection="column"
        width={viewport.width}
        height={viewport.height}
        paddingLeft={1}
        paddingRight={1}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="cyan">🧭 Mach-One Supervisor</Text>
          <Text color="gray">{headerStatus}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {visiblePanes.map((pane) => {
            const availableLines = Math.max(1, paneHeight - 2);
            const visibleLines = fitLines(pane.lines, availableLines);
            const paneTitle = pane.status
              ? `${pane.title} - ${pane.status}`
              : pane.title;
            return (
              <Box
                key={pane.id}
                flexDirection="column"
                height={paneHeight}
                marginTop={1}
              >
                <Text color="cyan">{paneTitle}</Text>
                {visibleLines.length > 0 ? (
                  visibleLines.map((line, index) => (
                    <Text key={`${pane.id}-line-${index}`}>{line}</Text>
                  ))
                ) : (
                  <Text color="gray">No output yet.</Text>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  };
};

export const createSupervisorUi = async (
  initialState: SupervisorUiState,
  maxLines = 200,
): Promise<SupervisorUiController> => {
  const Ink = (await import("ink")) as InkModule;
  const { render } = Ink;
  const SupervisorUI = makeSupervisorComponent(Ink);

  let currentState = initialState;
  const instance = render(<SupervisorUI state={currentState} />);

  const updatePane = (
    paneId: string,
    updater: (pane: SupervisorPaneState) => SupervisorPaneState,
  ) => {
    currentState = {
      ...currentState,
      panes: currentState.panes.map((pane) =>
        pane.id === paneId ? updater(pane) : pane,
      ),
    };
    instance.rerender(<SupervisorUI state={currentState} />);
  };

  return {
    appendLine: (paneId, line) => {
      updatePane(paneId, (pane) => {
        const lines = [...pane.lines, line].slice(-maxLines);
        return { ...pane, lines };
      });
    },
    setPaneStatus: (paneId, status) => {
      updatePane(paneId, (pane) => ({ ...pane, status }));
    },
    setStatus: (status) => {
      currentState = { ...currentState, status };
      instance.rerender(<SupervisorUI state={currentState} />);
    },
    unmount: () => {
      instance.unmount();
    },
  };
};
