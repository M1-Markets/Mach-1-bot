import { ConfigManager } from "@/domains/configuration/config-manager";
import { Address } from "@/shared/types/common";

describe("ConfigManager", () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    configManager = new ConfigManager();
  });

  describe("constructor", () => {
    it("should initialize config manager", () => {
      expect(configManager).toBeDefined();
      expect(configManager).toBeInstanceOf(ConfigManager);
    });
  });

  describe("loadConfig", () => {
    it("should load configuration from object", () => {
      const config = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      const result = configManager.loadConfig(config);

      expect(result).toBeDefined();
      expect(result.privateKey).toBe(config.privateKey);
      expect(result.rpcUrl).toBe(config.rpcUrl);
    });

    it("should validate required fields", () => {
      const invalidConfig = {
        privateKey: "", // Missing
        rpcUrl: "https://test-rpc.sei.io",
      };

      expect(() => configManager.loadConfig(invalidConfig)).toThrow();
    });

    it("should apply default values", () => {
      const minimalConfig = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      const result = configManager.loadConfig(minimalConfig);

      expect(result.mode).toBe("paper"); // Default value
      expect(result.maxRetries).toBe(3); // Default value
    });
  });

  describe("validateConfig", () => {
    it("should validate complete configuration", () => {
      const validConfig = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      expect(() => configManager.validateConfig(validConfig)).not.toThrow();
    });

    it("should reject invalid private key format", () => {
      const invalidConfig = {
        privateKey: "invalid_key",
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      expect(() => configManager.validateConfig(invalidConfig)).toThrow(
        "Invalid private key format",
      );
    });

    it("should reject invalid RPC URL", () => {
      const invalidConfig = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "invalid-url",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      expect(() => configManager.validateConfig(invalidConfig)).toThrow(
        "Invalid RPC URL format",
      );
    });

    it("should reject invalid contract addresses", () => {
      const invalidConfig = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "invalid_address" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      expect(() => configManager.validateConfig(invalidConfig)).toThrow(
        "Invalid contract address for clob",
      );
    });
  });

  describe("getConfig", () => {
    it("should return current configuration", () => {
      const config = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      configManager.loadConfig(config);
      const result = configManager.getConfig();

      expect(result.rpcUrl).toBe(config.rpcUrl);
    });

    it("should throw if no config loaded", () => {
      expect(() => configManager.getConfig()).toThrow(
        "No configuration loaded",
      );
    });

    it("should sanitize sensitive data in returned config", () => {
      const config = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      configManager.loadConfig(config);
      const result = configManager.getConfig(true); // sanitized = true

      expect(result.privateKey).toBe("0x****...****"); // Sanitized
    });
  });

  describe("updateConfig", () => {
    it("should update specific configuration fields", () => {
      const initialConfig = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
        mode: "simulation" as const,
      };

      configManager.loadConfig(initialConfig);

      const updates = {
        mode: "live" as const,
        maxRetries: 5,
      };

      configManager.updateConfig(updates);
      const result = configManager.getConfig();

      expect(result.mode).toBe("live");
      expect(result.maxRetries).toBe(5);
    });

    it("should validate updates before applying", () => {
      const initialConfig = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      configManager.loadConfig(initialConfig);

      const invalidUpdates = {
        privateKey: "invalid_key",
      };

      expect(() => configManager.updateConfig(invalidUpdates)).toThrow();
    });
  });

  describe("resetToDefaults", () => {
    it("should reset configuration to default values", () => {
      const config = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
        maxRetries: 10,
        timeout: 60000,
      };

      configManager.loadConfig(config);
      configManager.resetToDefaults();

      const result = configManager.getConfig();
      expect(result.maxRetries).toBe(3); // Default value
      expect(result.timeout).toBe(30000); // Default value
    });
  });

  describe("exportConfig", () => {
    it("should export configuration to JSON", () => {
      const config = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      configManager.loadConfig(config);
      const exported = configManager.exportConfig();

      expect(typeof exported).toBe("string");
      const parsed = JSON.parse(exported);
      expect(parsed.rpcUrl).toBe(config.rpcUrl);
    });

    it("should exclude sensitive data when exporting", () => {
      const config = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      configManager.loadConfig(config);
      const exported = configManager.exportConfig(true); // excludeSensitive = true

      const parsed = JSON.parse(exported);
      expect(parsed.privateKey).toBeUndefined();
    });
  });

  describe("loadFromFile", () => {
    it("should load configuration from file path", async () => {
      // This would normally test actual file loading
      // For now, we test the method exists and handles errors
      await expect(
        configManager.loadFromFile("nonexistent.json"),
      ).rejects.toThrow();
    });
  });

  describe("saveToFile", () => {
    it("should save configuration to file", async () => {
      const config = {
        privateKey: "0x" + "1".repeat(64),
        rpcUrl: "https://test-rpc.sei.io",
        contractAddresses: {
          clob: "0x1234567890123456789012345678901234567890" as Address,
          book: "0x2345678901234567890123456789012345678901" as Address,
          state: "0x3456789012345678901234567890123456789012" as Address,
          vault: "0x4567890123456789012345678901234567890123" as Address,
        },
      };

      configManager.loadConfig(config);

      // This would normally test actual file saving
      // For now, we test the method exists
      await expect(
        configManager.saveToFile("test-config.json"),
      ).resolves.toBeUndefined();
    });
  });
});
