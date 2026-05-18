import { vi } from "vitest";
import { AIAgent } from "@/domains/bot/ai-agent";

type MockFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

const mockFetchOnce = (payload: unknown, ok = true): void => {
  const response: MockFetchResponse = {
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    response as unknown as Response,
  );
};

describe("AIAgent", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({} as Response),
    ) as typeof fetch;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns default strategy decision when api key is missing", async () => {
    const agent = new AIAgent({
      provider: "chatgpt",
      model: "gpt-4o-mini",
    });

    const decision = await agent.analyzeStrategyControl({
      marketData: {},
    });

    expect(decision.action).toBe("continue");
    expect(decision.shouldContinue).toBe(true);
    expect(decision.reason).toContain("Missing AI API key");
  });

  it("parses strategy decision from AI response", async () => {
    const agent = new AIAgent({
      provider: "chatgpt",
      model: "gpt-4o-mini",
      apiKey: "test-key",
    });

    mockFetchOnce({
      output_text: JSON.stringify({
        action: "pause",
        confidence: 0.88,
        reason: "High volatility detected",
      }),
    });

    const decision = await agent.analyzeStrategyControl({
      marketData: {},
      metrics: { maxDrawdown: 0.12 },
    });

    expect(decision.action).toBe("pause");
    expect(decision.shouldContinue).toBe(false);
    expect(decision.confidence).toBeCloseTo(0.88);
    expect(decision.reason).toBe("High volatility detected");
  });

  it("defaults to continue when strategy response is invalid JSON", async () => {
    const agent = new AIAgent({
      provider: "chatgpt",
      model: "gpt-4o-mini",
      apiKey: "test-key",
    });

    mockFetchOnce({
      output_text: "not-json",
    });

    const decision = await agent.analyzeStrategyControl({
      marketData: {},
    });

    expect(decision.action).toBe("continue");
    expect(decision.shouldContinue).toBe(true);
    expect(decision.reason).toContain("Unable to parse");
  });

  it("parses order decision from AI response", async () => {
    const agent = new AIAgent({
      provider: "chatgpt",
      model: "gpt-4o-mini",
      apiKey: "test-key",
    });

    mockFetchOnce({
      output_text: JSON.stringify({
        action: "reject",
        confidence: 0.72,
        reason: "Signal quality too low",
      }),
    });

    const decision = await agent.analyzeOrderDecision({
      marketData: {},
      signal: {
        action: "buy",
        pair: "ETH/USDC",
        confidence: 0.2,
        reason: "weak signal",
      },
    });

    expect(decision.action).toBe("reject");
    expect(decision.confidence).toBeCloseTo(0.72);
    expect(decision.reason).toBe("Signal quality too low");
  });

  it("defaults to approve when order response is invalid JSON", async () => {
    const agent = new AIAgent({
      provider: "chatgpt",
      model: "gpt-4o-mini",
      apiKey: "test-key",
    });

    mockFetchOnce({
      output_text: "nonsense",
    });

    const decision = await agent.analyzeOrderDecision({
      marketData: {},
      signal: {
        action: "sell",
        pair: "BTC/USDC",
      },
    });

    expect(decision.action).toBe("approve");
    expect(decision.reason).toContain("Unable to parse");
  });
});
