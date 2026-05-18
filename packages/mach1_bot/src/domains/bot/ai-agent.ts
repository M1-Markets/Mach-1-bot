import type { MarketData } from "@/shared/types";
import type {
  AIProvider,
  AiOrderDecision,
  AiOrderSnapshot,
  AiStrategyDecision,
  AiStrategySnapshot,
} from "@/shared/types/ai";
import { getDefaultAiPrompt } from "@/shared/utils/ai-utils";

export interface AIDecision {
  action: "buy" | "sell" | "hold";
  symbol: string;
  amount: number;
  confidence: number;
  reasoning: string;
}

export interface AIConfig {
  provider: AIProvider;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  prompt?: string;
}

export class AIAgent {
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
  }

  static fromConfig(model: string): AIAgent {
    return new AIAgent({
      provider: "chatgpt",
      model,
      apiKey: process.env.OPENAI_API_KEY,
      temperature: 0.7,
      maxTokens: 150,
      prompt: getDefaultAiPrompt(),
    });
  }

  static fromHelperConfig(config: {
    provider: AIProvider;
    apiKey: string;
    prompt?: string;
  }): AIAgent {
    const defaultModel =
      config.provider === "gemini"
        ? "gemini-2.5-flash"
        : config.provider === "claude"
          ? "claude-sonnet-4-20250514"
          : "gpt-4o-mini";

    return new AIAgent({
      provider: config.provider,
      model: defaultModel,
      apiKey: config.apiKey,
      temperature: 0.2,
      maxTokens: 256,
      prompt: config.prompt ?? getDefaultAiPrompt(),
    });
  }

  async analyzeMarket(data: MarketData): Promise<AIDecision> {
    // TODO: Implement AI-powered market analysis
    // This would integrate with OpenAI, Claude, or other AI services

    // Mock decision for now
    const symbols = Object.keys(data);
    const randomSymbol = symbols[Math.floor(Math.random() * symbols.length)];
    const marketData = data[randomSymbol];

    // Simple mock logic based on RSI
    let action: "buy" | "sell" | "hold" = "hold";
    let confidence = 0.5;
    let reasoning = "Market conditions are neutral";

    if (marketData.rsi < 30) {
      action = "buy";
      confidence = 0.8;
      reasoning =
        "RSI indicates oversold conditions, potential buying opportunity";
    } else if (marketData.rsi > 70) {
      action = "sell";
      confidence = 0.75;
      reasoning =
        "RSI indicates overbought conditions, potential selling opportunity";
    }

    return {
      action,
      symbol: randomSymbol,
      amount: 100, // Default amount
      confidence,
      reasoning,
    };
  }

  async analyzeStrategyControl(
    snapshot: AiStrategySnapshot,
  ): Promise<AiStrategyDecision> {
    if (!this.config.apiKey) {
      return this.defaultStrategyDecision(
        "Missing AI API key; continuing without AI gating.",
      );
    }

    const prompt = this.buildStrategyPrompt(snapshot);

    try {
      const responseText = await this.requestStrategyDecision(prompt);
      const parsed = this.parseStrategyDecision(responseText);
      if (parsed) {
        return parsed;
      }
      return this.defaultStrategyDecision(
        "Unable to parse AI response; continuing.",
        responseText,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown AI error";
      return this.defaultStrategyDecision(
        `AI request failed: ${message}. Continuing.`,
      );
    }
  }

  async analyzeOrderDecision(
    snapshot: AiOrderSnapshot,
  ): Promise<AiOrderDecision> {
    if (!this.config.apiKey) {
      return this.defaultOrderDecision(
        "Missing AI API key; approving order without AI gating.",
      );
    }

    const prompt = this.buildOrderPrompt(snapshot);

    try {
      const responseText = await this.requestStrategyDecision(prompt);
      const parsed = this.parseOrderDecision(responseText);
      if (parsed) {
        return parsed;
      }
      return this.defaultOrderDecision(
        "Unable to parse AI response; approving order.",
        responseText,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown AI error";
      return this.defaultOrderDecision(
        `AI request failed: ${message}. Approving order.`,
      );
    }
  }

  private defaultStrategyDecision(
    reason: string,
    rawResponse?: string,
  ): AiStrategyDecision {
    return {
      action: "continue",
      shouldContinue: true,
      confidence: 0.2,
      reason,
      rawResponse,
    };
  }

  private defaultOrderDecision(
    reason: string,
    rawResponse?: string,
  ): AiOrderDecision {
    return {
      action: "approve",
      confidence: 0.2,
      reason,
      rawResponse,
    };
  }

  private buildStrategyPrompt(snapshot: AiStrategySnapshot): string {
    const serialized = JSON.stringify(snapshot);
    return `${this.config.prompt ?? getDefaultAiPrompt()}

You must output a single JSON object with these fields:
- action: "continue" | "pause" | "stop"
- confidence: number between 0 and 1
- reason: short string
- recommendations: array of strings (optional)

Decide whether the strategy should continue, pause, or stop based on the snapshot below.
SNAPSHOT: ${serialized}`;
  }

  private buildOrderPrompt(snapshot: AiOrderSnapshot): string {
    const serialized = JSON.stringify(snapshot);
    return `${this.config.prompt ?? getDefaultAiPrompt()}

You are reviewing a proposed order generated by the strategy. Be strict about risk, drawdown, and signal quality.
If the order materially increases risk or conflicts with the prevailing market conditions, reject it.
If conditions are ambiguous or highly volatile, choose "pause".

You must output a single JSON object with these fields:
- action: "approve" | "reject" | "pause"
- confidence: number between 0 and 1
- reason: short string
- recommendations: array of strings (optional)

Decide whether to approve the order based on the snapshot below.
SNAPSHOT: ${serialized}`;
  }

  private async requestGemini(prompt: string): Promise<string> {
    const apiKey = this.config.apiKey;
    const model = this.config.model.startsWith("models/")
      ? this.config.model
      : `models/${this.config.model}`;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: this.config.temperature ?? 0.2,
        maxOutputTokens: this.config.maxTokens ?? 256,
      },
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini error ${response.status}: ${errorText}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((part) => part.text ?? "").join("");
    return text.trim();
  }

  private async requestClaude(prompt: string): Promise<string> {
    const apiKey = this.config.apiKey;
    const model = this.config.model;
    const endpoint = "https://api.anthropic.com/v1/messages";

    const body = {
      model,
      max_tokens: this.config.maxTokens ?? 256,
      temperature: this.config.temperature ?? 0.2,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude error ${response.status}: ${errorText}`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ text?: string }>;
    };

    const text = payload.content?.map((part) => part.text ?? "").join("") ?? "";
    return text.trim();
  }

  private async requestChatGPT(prompt: string): Promise<string> {
    const apiKey = this.config.apiKey;
    const model = this.config.model;
    const endpoint = "https://api.openai.com/v1/responses";

    const body = {
      model,
      temperature: this.config.temperature ?? 0.2,
      max_output_tokens: this.config.maxTokens ?? 256,
      input: prompt,
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ChatGPT error ${response.status}: ${errorText}`);
    }

    const payload = (await response.json()) as {
      output_text?: string;
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
        text?: string;
      }>;
    };

    const directText = payload.output_text;
    if (typeof directText === "string" && directText.trim().length > 0) {
      return directText.trim();
    }

    const outputItems = payload.output ?? [];
    const collected: string[] = [];
    for (const item of outputItems) {
      if (typeof item.text === "string") {
        collected.push(item.text);
      }
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (
            typeof part.text === "string" &&
            (part.type === "output_text" || part.type === "text")
          ) {
            collected.push(part.text);
          }
        }
      }
    }

    return collected.join("").trim();
  }

  private async requestStrategyDecision(prompt: string): Promise<string> {
    if (this.config.provider === "gemini") {
      return this.requestGemini(prompt);
    }
    if (this.config.provider === "claude") {
      return this.requestClaude(prompt);
    }
    return this.requestChatGPT(prompt);
  }

  private parseStrategyDecision(text: string): AiStrategyDecision | undefined {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      return undefined;
    }

    const jsonSlice = text.slice(jsonStart, jsonEnd + 1);
    let parsed: {
      action?: string;
      confidence?: number;
      reason?: string;
      recommendations?: string[];
    };
    try {
      parsed = JSON.parse(jsonSlice) as {
        action?: string;
        confidence?: number;
        reason?: string;
        recommendations?: string[];
      };
    } catch {
      return undefined;
    }

    const action =
      parsed.action === "pause" || parsed.action === "stop"
        ? parsed.action
        : "continue";
    const confidence =
      typeof parsed.confidence === "number" && parsed.confidence >= 0
        ? Math.min(parsed.confidence, 1)
        : 0.3;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.length > 0
        ? parsed.reason
        : "AI did not provide a reason.";

    return {
      action,
      shouldContinue: action === "continue",
      confidence,
      reason,
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.filter((item) => typeof item === "string")
        : undefined,
      rawResponse: text,
    };
  }

  private parseOrderDecision(text: string): AiOrderDecision | undefined {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      return undefined;
    }

    const jsonSlice = text.slice(jsonStart, jsonEnd + 1);
    let parsed: {
      action?: string;
      confidence?: number;
      reason?: string;
      recommendations?: string[];
    };
    try {
      parsed = JSON.parse(jsonSlice) as {
        action?: string;
        confidence?: number;
        reason?: string;
        recommendations?: string[];
      };
    } catch {
      return undefined;
    }

    const action =
      parsed.action === "reject" || parsed.action === "pause"
        ? parsed.action
        : "approve";
    const confidence =
      typeof parsed.confidence === "number" && parsed.confidence >= 0
        ? Math.min(parsed.confidence, 1)
        : 0.3;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.length > 0
        ? parsed.reason
        : "AI did not provide a reason.";

    return {
      action,
      confidence,
      reason,
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.filter((item) => typeof item === "string")
        : undefined,
      rawResponse: text,
    };
  }

  async generateStrategy(marketConditions: string[]): Promise<{
    strategyCode: string;
    description: string;
    riskLevel: "low" | "medium" | "high";
  }> {
    // TODO: Generate trading strategy code using AI
    return {
      strategyCode: `
        // AI Generated Strategy (stub)
        async function aiStrategy(data) {
          // Generated based on current market conditions
          const rsi = data["ETH/USDC"].rsi;
          if (rsi < 30) {
            await bot.buy("ETH/USDC", { amountUsd: 100 });
          } else if (rsi > 70) {
            await bot.sell("ETH/USDC", { amountUsd: 100 });
          }
        }
      `,
      description: "AI-generated RSI-based strategy",
      riskLevel: "medium",
    };
  }

  async optimizeParameters(
    strategyCode: string,
    backtestResults: unknown,
  ): Promise<{
    optimizedParameters: Record<string, unknown>;
    expectedImprovement: number;
  }> {
    // TODO: Use AI to optimize strategy parameters
    return {
      optimizedParameters: {
        rsiOverbought: 75,
        rsiOversold: 25,
        positionSize: 150,
      },
      expectedImprovement: 0.15, // 15% improvement expected
    };
  }

  async analyzeRisk(
    portfolio: unknown,
    marketData: MarketData,
  ): Promise<{
    riskScore: number;
    recommendations: string[];
    hedgingStrategies: string[];
  }> {
    // TODO: AI-powered risk analysis
    return {
      riskScore: 0.3, // 30% risk
      recommendations: [
        "Consider reducing position size in volatile assets",
        "Implement stop-loss orders at 5% below entry",
        "Diversify across more uncorrelated assets",
      ],
      hedgingStrategies: [
        "Add short positions in correlated assets",
        "Use options for downside protection",
        "Increase cash allocation during high volatility",
      ],
    };
  }

  async generateMarketInsights(data: MarketData): Promise<{
    sentiment: "bullish" | "bearish" | "neutral";
    keyDrivers: string[];
    predictions: Array<{
      symbol: string;
      direction: "up" | "down" | "sideways";
      timeframe: string;
      confidence: number;
    }>;
  }> {
    // TODO: Generate comprehensive market insights
    return {
      sentiment: "neutral",
      keyDrivers: [
        "Federal Reserve policy uncertainty",
        "Institutional adoption trends",
        "Technical support/resistance levels",
      ],
      predictions: Object.keys(data).map((symbol) => ({
        symbol,
        direction: "sideways" as const,
        timeframe: "1d",
        confidence: 0.6,
      })),
    };
  }

  async trainOnHistoricalData(
    historicalData: unknown[],
    outcomes: unknown[],
  ): Promise<{
    trainingAccuracy: number;
    modelVersion: string;
    improvements: string[];
  }> {
    // TODO: Train AI model on historical trading data
    return {
      trainingAccuracy: 0.72,
      modelVersion: "v1.2.3",
      improvements: [
        "Better pattern recognition in volatile markets",
        "Improved risk assessment accuracy",
        "Enhanced multi-timeframe analysis",
      ],
    };
  }

  async explainDecision(decision: AIDecision): Promise<{
    reasoning: string;
    factors: Array<{
      factor: string;
      weight: number;
      impact: "positive" | "negative" | "neutral";
    }>;
    alternatives: AIDecision[];
  }> {
    // TODO: Provide detailed explanation of AI decision
    return {
      reasoning: decision.reasoning,
      factors: [
        { factor: "RSI Level", weight: 0.4, impact: "positive" },
        { factor: "Volume Trend", weight: 0.3, impact: "neutral" },
        { factor: "Support/Resistance", weight: 0.3, impact: "positive" },
      ],
      alternatives: [],
    };
  }
}
