import {
  ConnectionError,
  createError,
  ErrorHandler,
  InsufficientBalanceError,
  InvalidAmountError,
  InvalidSymbolError,
  MachOneError,
  NetworkError,
  RiskError,
  RiskLimitExceededError,
  StrategyError,
  TradingError,
  ValidationError,
} from "@/errors";

describe("Error Classes", () => {
  describe("MachOneError", () => {
    it("should create base error with all properties", () => {
      const error = new MachOneError(
        "TEST_CODE",
        "VALIDATION",
        "Test message",
        { extra: "data" },
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe("TEST_CODE");
      expect(error.category).toBe("VALIDATION");
      expect(error.message).toBe("Test message");
      expect(error.details).toEqual({ extra: "data" });
      expect(error.name).toBe("MachOneError");
    });

    it("should serialize to JSON correctly", () => {
      const error = new MachOneError(
        "TEST_CODE",
        "VALIDATION",
        "Test message",
        { extra: "data" },
      );
      const json = error.toJSON();

      expect(json.name).toBe("MachOneError");
      expect(json.code).toBe("TEST_CODE");
      expect(json.category).toBe("VALIDATION");
      expect(json.message).toBe("Test message");
      expect(json.details).toEqual({ extra: "data" });
      expect(json.stack).toBeDefined();
    });
  });

  describe("ValidationError", () => {
    it("should create validation error", () => {
      const error = new ValidationError("Invalid input");

      expect(error).toBeInstanceOf(MachOneError);
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.category).toBe("VALIDATION");
      expect(error.message).toBe("Invalid input");
    });
  });

  describe("InvalidSymbolError", () => {
    it("should create invalid symbol error", () => {
      const error = new InvalidSymbolError("INVALID");

      expect(error).toBeInstanceOf(MachOneError);
      expect(error.code).toBe("INVALID_SYMBOL");
      expect(error.category).toBe("VALIDATION");
      expect(error.message).toContain("INVALID");
      expect(error.message).toContain("ETH/USDC");
    });
  });

  describe("InvalidAmountError", () => {
    it("should create invalid amount error with number", () => {
      const error = new InvalidAmountError(-100, "must be positive");

      expect(error.code).toBe("INVALID_AMOUNT");
      expect(error.message).toContain("-100");
      expect(error.message).toContain("must be positive");
    });

    it("should create invalid amount error with bigint", () => {
      const error = new InvalidAmountError(0n);

      expect(error.code).toBe("INVALID_AMOUNT");
      expect(error.message).toContain("0");
    });
  });

  describe("TradingError", () => {
    it("should create trading error", () => {
      const error = new TradingError("Order failed");

      expect(error).toBeInstanceOf(MachOneError);
      expect(error.code).toBe("TRADING_ERROR");
      expect(error.category).toBe("TRADING");
      expect(error.message).toBe("Order failed");
    });
  });

  describe("InsufficientBalanceError", () => {
    it("should create insufficient balance error", () => {
      const error = new InsufficientBalanceError(1000n, 500n, "USDC");

      expect(error.code).toBe("INSUFFICIENT_BALANCE");
      expect(error.category).toBe("TRADING");
      expect(error.message).toContain("USDC");
      expect(error.message).toContain("1000");
      expect(error.message).toContain("500");
    });
  });

  describe("NetworkError", () => {
    it("should create network error", () => {
      const error = new NetworkError("Connection timeout");

      expect(error).toBeInstanceOf(MachOneError);
      expect(error.code).toBe("NETWORK_ERROR");
      expect(error.category).toBe("NETWORK");
      expect(error.message).toBe("Connection timeout");
    });
  });

  describe("ConnectionError", () => {
    it("should create connection error", () => {
      const originalError = new Error("Socket timeout");
      const error = new ConnectionError("wss://api.example.com", originalError);

      expect(error.code).toBe("CONNECTION_ERROR");
      expect(error.category).toBe("NETWORK");
      expect(error.message).toContain("wss://api.example.com");
      expect(error.message).toContain("Socket timeout");
    });
  });

  describe("StrategyError", () => {
    it("should create strategy error", () => {
      const error = new StrategyError("DCA execution failed");

      expect(error).toBeInstanceOf(MachOneError);
      expect(error.code).toBe("STRATEGY_ERROR");
      expect(error.category).toBe("STRATEGY");
      expect(error.message).toBe("DCA execution failed");
    });
  });

  describe("RiskError", () => {
    it("should create risk management error", () => {
      const error = new RiskError("Position size too large");

      expect(error).toBeInstanceOf(MachOneError);
      expect(error.code).toBe("RISK_ERROR");
      expect(error.category).toBe("RISK");
      expect(error.message).toBe("Position size too large");
    });
  });

  describe("RiskLimitExceededError", () => {
    it("should create risk limit exceeded error", () => {
      const error = new RiskLimitExceededError("Daily Loss", 1500, 1000);

      expect(error.code).toBe("RISK_LIMIT_EXCEEDED");
      expect(error.category).toBe("RISK");
      expect(error.message).toContain("Daily Loss");
      expect(error.message).toContain("1500");
      expect(error.message).toContain("1000");
    });
  });
});

describe("Error Factory", () => {
  describe("createError", () => {
    it("should create validation error", () => {
      const error = createError(
        "validation",
        "CUSTOM_VALIDATION",
        "Custom validation message",
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.message).toBe("Custom validation message");
    });

    it("should create trading error", () => {
      const error = createError(
        "trading",
        "CUSTOM_TRADING",
        "Custom trading message",
      );

      expect(error).toBeInstanceOf(TradingError);
      expect(error.message).toBe("Custom trading message");
    });

    it("should create network error", () => {
      const error = createError(
        "network",
        "CUSTOM_NETWORK",
        "Custom network message",
      );

      expect(error).toBeInstanceOf(NetworkError);
      expect(error.message).toBe("Custom network message");
    });

    it("should create strategy error", () => {
      const error = createError(
        "strategy",
        "CUSTOM_STRATEGY",
        "Custom strategy message",
      );

      expect(error).toBeInstanceOf(StrategyError);
      expect(error.message).toBe("Custom strategy message");
    });

    it("should create risk error", () => {
      const error = createError("risk", "CUSTOM_RISK", "Custom risk message");

      expect(error).toBeInstanceOf(RiskError);
      expect(error.message).toBe("Custom risk message");
    });

    it("should create config error", () => {
      const error = createError(
        "config",
        "CUSTOM_CONFIG",
        "Custom config message",
      );

      expect(error.message).toBe("Custom config message");
    });
  });
});

describe("ErrorHandler", () => {
  let errorHandler: ErrorHandler;

  beforeEach(() => {
    errorHandler = ErrorHandler.getInstance();
    // Clear any existing callbacks
    const handler = errorHandler as unknown as {
      errorCallbacks: Array<(error: MachOneError) => void>;
    };
    handler.errorCallbacks = [];
  });

  describe("getInstance", () => {
    it("should return singleton instance", () => {
      const handler1 = ErrorHandler.getInstance();
      const handler2 = ErrorHandler.getInstance();

      expect(handler1).toBe(handler2);
    });
  });

  describe("onError", () => {
    it("should register error callback", () => {
      const callback = vi.fn();

      errorHandler.onError(callback);

      const handler = errorHandler as unknown as {
        errorCallbacks: Array<(error: MachOneError) => void>;
      };
      expect(handler.errorCallbacks).toContain(callback);
    });

    it("should register multiple callbacks", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      errorHandler.onError(callback1);
      errorHandler.onError(callback2);

      const handler = errorHandler as unknown as {
        errorCallbacks: Array<(error: MachOneError) => void>;
      };
      expect(handler.errorCallbacks).toHaveLength(2);
    });
  });

  describe("handle", () => {
    it("should handle MachOneError", () => {
      const callback = vi.fn();
      errorHandler.onError(callback);

      const error = new ValidationError("Test error");
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      errorHandler.handle(error);

      expect(consoleSpy).toHaveBeenCalledWith("SDK Error:", error.toJSON());
      expect(callback).toHaveBeenCalledWith(error);

      consoleSpy.mockRestore();
    });

    it("should convert regular Error to MachOneError", () => {
      const callback = vi.fn();
      errorHandler.onError(callback);

      const error = new Error("Regular error");
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      errorHandler.handle(error);

      expect(callback).toHaveBeenCalledWith(expect.any(MachOneError));
      expect(callback.mock.calls[0][0].message).toBe("Regular error");
      expect(callback.mock.calls[0][0].details.originalError).toBe(error);

      consoleSpy.mockRestore();
    });

    it("should handle callback errors gracefully", () => {
      const goodCallback = vi.fn();
      const badCallback = vi.fn(() => {
        throw new Error("Callback error");
      });

      errorHandler.onError(goodCallback);
      errorHandler.onError(badCallback);

      const error = new ValidationError("Test error");
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      expect(() => errorHandler.handle(error)).not.toThrow();

      expect(goodCallback).toHaveBeenCalledWith(error);
      expect(badCallback).toHaveBeenCalledWith(error);
      expect(consoleSpy).toHaveBeenCalledTimes(2); // Original error + callback error

      consoleSpy.mockRestore();
    });
  });

  describe("isRetryable", () => {
    it("should identify retryable errors", () => {
      const connectionError = new ConnectionError("api.example.com");
      const networkError = new NetworkError("Timeout");
      const validationError = new ValidationError("Invalid input");

      expect(errorHandler.isRetryable(connectionError)).toBe(true);
      expect(errorHandler.isRetryable(networkError)).toBe(true);
      expect(errorHandler.isRetryable(validationError)).toBe(false);
    });
  });

  describe("shouldEmergencyStop", () => {
    it("should identify errors requiring emergency stop", () => {
      const riskError = new RiskLimitExceededError("Daily Loss", 1500, 1000);
      const validationError = new ValidationError("Invalid input");

      expect(errorHandler.shouldEmergencyStop(riskError)).toBe(true);
      expect(errorHandler.shouldEmergencyStop(validationError)).toBe(false);
    });
  });
});
