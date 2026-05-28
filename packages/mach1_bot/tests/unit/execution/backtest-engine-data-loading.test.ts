import { BacktestEngine } from "@/domains/execution/backtest-engine";
import type { DataFileInfo } from "@/shared/types";

const createFiles = (): DataFileInfo[] => [
  {
    filePath: "/tmp/backtest-data/SOLUSDT-trades-2024-01-02.csv",
    tradingPair: "SOLUSDT",
    date: new Date("2024-01-02T00:00:00Z"),
    directory: "backtest-data",
    fileSize: 100,
  },
  {
    filePath: "/tmp/backtest-data/BTCUSDT-trades-2024-01-02.csv",
    tradingPair: "BTCUSDT",
    date: new Date("2024-01-02T00:00:00Z"),
    directory: "backtest-data",
    fileSize: 100,
  },
  {
    filePath: "/tmp/backtest-data/ETHUSDT-trades-2024-01-02.csv",
    tradingPair: "ETHUSDT",
    date: new Date("2024-01-02T00:00:00Z"),
    directory: "backtest-data",
    fileSize: 100,
  },
];

describe("BacktestEngine data loading filters configured pairs", () => {
  it("ignores unrelated datasets for a single-pair backtest", async () => {
    const engine = new BacktestEngine({
      startDate: new Date("2024-01-01T00:00:00Z"),
      endDate: new Date("2024-01-03T00:00:00Z"),
      initialCapital: 100000n,
      commission: 0.001,
      slippage: 0.001,
      dataDirectory: "/tmp/nonexistent-backtest-data",
      tradingPairs: ["SOL/USDC"],
    });
    const files = createFiles();
    const loadMultipleDataFiles = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(
      engine as unknown as {
        discoverDataFiles: () => Promise<DataFileInfo[]>;
      },
      "discoverDataFiles",
    ).mockResolvedValue(files);
    (
      engine as unknown as {
        loadMultipleDataFiles: (files: DataFileInfo[]) => Promise<void>;
      }
    ).loadMultipleDataFiles = loadMultipleDataFiles;

    await (
      engine as unknown as {
        checkAndLoadBacktestData: () => Promise<void>;
      }
    ).checkAndLoadBacktestData();

    expect(loadMultipleDataFiles).toHaveBeenCalledWith([files[0]]);
  });

  it("keeps requested multiple markets when config includes several pairs", async () => {
    const engine = new BacktestEngine({
      startDate: new Date("2024-01-01T00:00:00Z"),
      endDate: new Date("2024-01-03T00:00:00Z"),
      initialCapital: 100000n,
      commission: 0.001,
      slippage: 0.001,
      dataDirectory: "/tmp/nonexistent-backtest-data",
      tradingPairs: ["SOL/USDC", "BTC/USDC"],
    });
    const files = createFiles();
    const loadMultipleDataFiles = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(
      engine as unknown as {
        discoverDataFiles: () => Promise<DataFileInfo[]>;
      },
      "discoverDataFiles",
    ).mockResolvedValue(files);
    (
      engine as unknown as {
        loadMultipleDataFiles: (files: DataFileInfo[]) => Promise<void>;
      }
    ).loadMultipleDataFiles = loadMultipleDataFiles;

    await (
      engine as unknown as {
        checkAndLoadBacktestData: () => Promise<void>;
      }
    ).checkAndLoadBacktestData();

    expect(loadMultipleDataFiles).toHaveBeenCalledWith([files[0], files[1]]);
  });
});
