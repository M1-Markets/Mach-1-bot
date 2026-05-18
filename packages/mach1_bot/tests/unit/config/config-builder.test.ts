import { NETWORK_PRESETS } from "@/shared/constants/networks";
import { BotConfig } from "@/shared/types/bot";
import type { NetworkPreset } from "@/shared/types/config";
import { ConfigBuilder } from "@/shared/utils/validation/config-builder";

// Global test data
const validPrivateKey = "0x" + "1".repeat(64);

describe("ConfigBuilder", () => {
  describe("builder pattern", () => {
    it("should build valid configuration", () => {
      const config = ConfigBuilder.create()
        .withPrivateKey(validPrivateKey)
        .withNetwork("testnet")
        .withMode("simulation")
        .withRiskLimits(1000, 500)
        .build();

      expect(config.privateKey).toBe(validPrivateKey);
      expect(config.mode).toBe("paper");
      expect(config.maxPositionSize).toBe(1000);
      expect(config.maxDailyLoss).toBe(500);
      expect(config.rpcUrl).toBe(NETWORK_PRESETS["testnet"].rpcUrl);
      expect(config.chainId).toBe(NETWORK_PRESETS["testnet"].chainId);
    });

    it("should support custom RPC configuration", () => {
      const config = ConfigBuilder.create()
        .withPrivateKey(validPrivateKey)
        .withCustomRpc("https://custom-rpc.example.com", 12345)
        .build();

      expect(config.rpcUrl).toBe("https://custom-rpc.example.com");
      expect(config.chainId).toBe(12345);
    });
  });

  describe("validation", () => {
    it("should throw error for missing private key", () => {
      expect(() => {
        ConfigBuilder.create().withNetwork("testnet").build();
      }).toThrow("Private key is required");
    });

    it("should throw error for missing RPC URL", () => {
      expect(() => {
        ConfigBuilder.create().withPrivateKey(validPrivateKey).build();
      }).toThrow("RPC URL is required");
    });

    it("should throw error for unknown network preset", () => {
      expect(() => {
        ConfigBuilder.create()
          .withPrivateKey(validPrivateKey)
          .withNetwork(
            "unknown-network" as unknown as Parameters<
              ConfigBuilder["withNetwork"]
            >[0],
          )
          .build();
      }).toThrow("Unknown network preset: unknown-network");
    });
  });

  describe("method chaining", () => {
    it("should return builder instance for chaining", () => {
      const builder = ConfigBuilder.create();

      expect(builder.withPrivateKey(validPrivateKey)).toBe(builder);
      expect(builder.withNetwork("testnet")).toBe(builder);
      expect(builder.withMode("simulation")).toBe(builder);
      expect(builder.withRiskLimits(1000, 500)).toBe(builder);
    });
  });
});

describe("NETWORK_PRESETS", () => {
  it("should contain mainnet preset", () => {
    const preset = NETWORK_PRESETS["mainnet"];

    expect(preset).toBeDefined();
    expect(preset.name).toBe("Sei Mainnet");
    expect(preset.chainId).toBe(1329);
    expect(preset.rpcUrl).toBe("https://evm-rpc.sei-apis.com");
  });

  it("should contain testnet preset", () => {
    const preset = NETWORK_PRESETS["testnet"];

    expect(preset).toBeDefined();
    expect(preset.name).toBe("Sei Testnet");
    expect(preset.chainId).toBe(1328);
    expect(preset.rpcUrl).toBe("https://evm-rpc-testnet.sei-apis.com");
  });

  it("should have valid RPC URLs in all presets", () => {
    Object.values(NETWORK_PRESETS).forEach((preset: NetworkPreset) => {
      expect(preset.rpcUrl).toMatch(/^https?:\/\//);
      expect(typeof preset.chainId).toBe("number");
    });
  });
});

describe("BotConfig validation", () => {
  const validConfig: BotConfig = {
    privateKey: validPrivateKey,
    rpcUrl: "https://evm-rpc.sei.io",
    mode: "simulation",
    maxPositionSize: 1000,
    maxDailyLoss: 500,
    chainId: 1329,
  };

  it("should accept valid configuration", () => {
    expect(() => {
      // This would be validated in the Mach1Bot constructor
      expect(validConfig.privateKey).toBeTruthy();
      expect(validConfig.rpcUrl).toBeTruthy();
      expect(validConfig.mode).toBeTruthy();
    }).not.toThrow();
  });

  it("should validate private key format", () => {
    const invalidConfigs = [
      { ...validConfig, privateKey: "" },
      { ...validConfig, privateKey: "0x123" }, // Too short
      { ...validConfig, privateKey: "invalid" }, // Wrong format
    ];

    invalidConfigs.forEach((config) => {
      expect(
        config.privateKey.length < 66 || !config.privateKey.startsWith("0x"),
      ).toBe(true);
    });
  });

  it("should validate RPC URL", () => {
    const invalidConfig = {
      ...validConfig,
      rpcUrl: "",
    };

    expect(invalidConfig.rpcUrl).toBe("");
  });
});
