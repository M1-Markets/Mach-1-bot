import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import "dotenv/config";
import { assert } from "chai";
import puppeteer, { Locator, type Browser, type Page } from "puppeteer";
import { hexToBytes, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const APP_URL = "https://app.m1.markets";
const ENABLE_ENV = "RUN_PUPPETEER_E2E";
const DEBUG_SCREENSHOT_DIR = "tests/puppeteer-artifacts";
const CHAIN_ID = 1328;

async function resetDebugScreenshotDir(): Promise<void> {
  await rm(DEBUG_SCREENSHOT_DIR, { recursive: true, force: true });
  await mkdir(DEBUG_SCREENSHOT_DIR, { recursive: true });
}

function sanitizeFileSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isBotChallengePage(title: string, bodyText: string): boolean {
  const haystack = `${title}\n${bodyText}`.toLowerCase();
  return (
    haystack.includes("just a moment") ||
    haystack.includes("checking your browser") ||
    haystack.includes("challenge-platform") ||
    haystack.includes("cloudflare")
  );
}

function isExecutionContextNavigationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context with specified id")
  );
}

async function readPageTitleAndBodyText(
  page: Page,
): Promise<{ title: string; bodyText: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const [title, bodyText] = await Promise.all([
        page.title(),
        page.evaluate(() => {
          const pageGlobal = globalThis as {
            document?: { body?: { innerText?: string } };
          };
          return pageGlobal.document?.body?.innerText ?? "";
        }),
      ]);

      return { title, bodyText };
    } catch (error) {
      if (!isExecutionContextNavigationError(error) || attempt === 4) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  throw new Error("unreachable");
}

async function saveTestScreenshot(
  page: Page,
  testTitle: string,
  state: string | undefined,
): Promise<string | undefined> {
  try {
    await mkdir(DEBUG_SCREENSHOT_DIR, { recursive: true });
    const safeTitle = sanitizeFileSegment(testTitle) || "test";
    const safeState = sanitizeFileSegment(state ?? "unknown") || "unknown";
    const filePath = join(
      DEBUG_SCREENSHOT_DIR,
      `${safeTitle}-${safeState}-${new Date().toISOString().replaceAll(":", "-")}.png`,
    );
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return undefined;
  }
}

async function dismissWorkInProgressModal(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page
      .waitForFunction(
        () => {
          const buttons = Array.from(document.querySelectorAll("button"));
          return buttons.some(
            (el) =>
              el.textContent?.replace(/\s+/g, " ").trim() === "I Understand",
          );
        },
        { timeout: 2_000 },
      )
      .catch(() => undefined);

    const clicked = await page
      .evaluate(() => {
        type MaybeButton = {
          textContent?: string;
          click?: () => void;
          getBoundingClientRect?: () => {
            width?: number;
            height?: number;
            top?: number;
          };
          ownerDocument?: {
            defaultView?: {
              getComputedStyle?: (el: unknown) => {
                display?: string;
                visibility?: string;
              };
            };
          };
        };
        const pageGlobal = globalThis as {
          document?: {
            querySelectorAll?: (selector: string) => Iterable<unknown>;
          };
        };

        const buttons = Array.from(
          pageGlobal.document?.querySelectorAll?.("button") ?? [],
        ) as MaybeButton[];
        const confirmButton = buttons.find((buttonElement) => {
          const text = buttonElement.textContent?.replace(/\s+/g, " ").trim();
          if (text !== "I Understand") {
            return false;
          }
          const rect = buttonElement.getBoundingClientRect?.();
          const style =
            buttonElement.ownerDocument?.defaultView?.getComputedStyle?.(
              buttonElement,
            );
          return (
            (rect?.width ?? 0) > 0 &&
            (rect?.height ?? 0) > 0 &&
            style?.display !== "none" &&
            style?.visibility !== "hidden"
          );
        });

        confirmButton?.click?.();
        return Boolean(confirmButton);
      })
      .catch(() => false);

    if (!clicked) {
      continue;
    }

    await page
      .waitForFunction(
        () => {
          const buttons = Array.from(document.querySelectorAll("button"));
          return buttons.every(
            (el) =>
              el.textContent?.replace(/\s+/g, " ").trim() !== "I Understand",
          );
        },
        { timeout: 5_000 },
      )
      .catch(() => undefined);

    const modalStillVisible = await page
      .evaluate(() => {
        const bodyText = document.body?.innerText?.toLowerCase() ?? "";
        return (
          bodyText.includes("work in progress") &&
          bodyText.includes("i understand")
        );
      })
      .catch(() => false);

    if (!modalStillVisible) {
      return;
    }
  }
}

async function waitForRenderableUi(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        document.readyState === "interactive" ||
        document.readyState === "complete",
      { timeout: 40_000 },
    )
    .catch(() => undefined);

  await page
    .waitForFunction(
      () => {
        const body = document.body;
        if (!body) {
          return false;
        }

        const domNodeCount = document.querySelectorAll("*").length;
        const normalizedText = (body.innerText ?? "")
          .replace(/\s+/g, " ")
          .trim();

        const keyNodes = Array.from(
          document.querySelectorAll(
            '[data-cy="trading-pair-display"], button, [role="button"], main, header',
          ),
        );

        const hasVisibleNode = keyNodes.some((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
          );
        });

        return (
          domNodeCount > 30 && (normalizedText.length > 40 || hasVisibleNode)
        );
      },
      { timeout: 30_000, polling: 200 },
    )
    .catch(() => undefined);
}

type WalletTestState = {
  requestCount: number;
  requestedMethods: string[];
  connected: boolean;
  address: string;
};

function _formatDecimalForInput(value: number, maxDecimals = 6): string {
  const fixed = value.toFixed(maxDecimals);
  return fixed.replace(/\.?0+$/, "");
}

function getWalletInjectionScript(address: string, chainId: number): string {
  return `
    (() => {
      const walletAddress = "${address}";
      const chainHex = "0x" + Number(${chainId}).toString(16);

      const state = {
        requestCount: 0,
        requestedMethods: [],
        connected: false,
        address: walletAddress,
        txNonce: 1,
        txByHash: {},
      };

      const listeners = new Map();

      const ensureMethodLog = (method) => {
        state.requestCount += 1;
        state.requestedMethods.push(method);
      };

      const emit = (event, payload) => {
        const cbs = listeners.get(event) || [];
        for (const cb of cbs) {
          try {
            cb(payload);
          } catch {
          }
        }
      };

      const provider = {
        isMetaMask: true,
        chainId: chainHex,
        networkVersion: String(${chainId}),
        selectedAddress: walletAddress,
        isConnected: () => true,
        _metamask: {
          isUnlocked: () => Promise.resolve(true),
        },
        on(event, callback) {
          const cbs = listeners.get(event) || [];
          cbs.push(callback);
          listeners.set(event, cbs);
        },
        removeListener(event, callback) {
          const cbs = listeners.get(event) || [];
          listeners.set(
            event,
            cbs.filter((cb) => cb !== callback),
          );
        },
        send(method, params) {
          if (typeof method === "object" && method) {
            return this.request(method);
          }
          return this.request({ method, params });
        },
        sendAsync(payload, callback) {
          this.request(payload)
            .then((result) => callback(null, { result }))
            .catch((error) => callback(error));
        },
        enable() {
          return this.request({ method: "eth_requestAccounts" });
        },
        async request({ method, params }) {
          ensureMethodLog(method);

          switch (method) {
            case "eth_chainId":
              return chainHex;
            case "net_version":
              return String(${chainId});
            case "eth_accounts":
              return [walletAddress];
            case "eth_requestAccounts":
              state.connected = true;
              emit("connect", { chainId: chainHex });
              emit("accountsChanged", [walletAddress]);
              return [walletAddress];
            case "personal_sign": {
              const message = params?.[0];
              return window.__m1SignPersonal?.(message);
            }
            case "eth_signTypedData":
            case "eth_signTypedData_v4": {
              const typedData = params?.[1];
              return window.__m1SignTypedData?.(typedData);
            }
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
            case "wallet_requestPermissions":
              return [{ parentCapability: "eth_accounts" }];
            case "wallet_getPermissions":
              return [{ parentCapability: "eth_accounts" }];
            case "wallet_revokePermissions":
              return null;
            case "eth_getBalance":
              return "0x" + (BigInt(1000000) * BigInt(10 ** 6)).toString(16);
            case "eth_getTransactionCount":
              return "0x" + Number(state.txNonce).toString(16);
            case "eth_gasPrice":
              return "0x3b9aca00";
            case "eth_maxPriorityFeePerGas":
              return "0x59682f00";
            case "eth_estimateGas":
              return "0x493e0";
            case "eth_blockNumber":
              return "0x" + (12345678).toString(16);
            case "eth_feeHistory":
              return {
                oldestBlock: "0xbc614e",
                baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
                gasUsedRatio: [0.5],
                reward: [["0x59682f00"]],
              };
            case "eth_getBlockByNumber":
              return {
                number: "0xbc614e",
                hash: "0x" + "ab".repeat(32),
                parentHash: "0x" + "cd".repeat(32),
                baseFeePerGas: "0x3b9aca00",
                timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
              };
            case "eth_call":
              return "0x";
            case "eth_sendTransaction":
            case "wallet_sendTransaction": {
              const tx = params?.[0] ?? {};
              const nonce = state.txNonce++;
              const hashSeed = String(nonce).padStart(64, "0");
              const txHash = "0x" + hashSeed;
              state.txByHash[txHash] = {
                hash: txHash,
                from: tx.from ?? walletAddress,
                to: tx.to ?? null,
                nonce,
              };
              return txHash;
            }
            case "eth_getTransactionByHash": {
              const txHash = params?.[0];
              const tx = txHash ? state.txByHash?.[txHash] : undefined;
              if (!tx) {
                return null;
              }
              return {
                hash: tx.hash,
                from: tx.from,
                to: tx.to,
                nonce: "0x" + Number(tx.nonce).toString(16),
                blockHash: "0x" + "12".repeat(32),
                blockNumber: "0xbc614e",
                transactionIndex: "0x0",
                gas: "0x493e0",
                gasPrice: "0x3b9aca00",
                input: "0x",
                value: "0x0",
                type: "0x2",
              };
            }
            case "eth_getTransactionReceipt": {
              const txHash = params?.[0];
              const tx = txHash ? state.txByHash?.[txHash] : undefined;
              if (!tx) {
                return null;
              }
              return {
                transactionHash: tx.hash,
                transactionIndex: "0x0",
                blockHash: "0x" + "34".repeat(32),
                blockNumber: "0xbc614e",
                from: tx.from,
                to: tx.to,
                cumulativeGasUsed: "0x5208",
                gasUsed: "0x5208",
                contractAddress: null,
                logs: [],
                logsBloom: "0x" + "00".repeat(256),
                status: "0x1",
                type: "0x2",
                effectiveGasPrice: "0x3b9aca00",
              };
            }
              return null;
            default:
              throw new Error("Unsupported injected wallet method: " + method);
          }
        },
      };

      Object.defineProperty(window, "ethereum", {
        value: provider,
        writable: false,
        configurable: true,
      });

      window.__m1InjectedWalletState = state;

      const info = {
        uuid: "f4b0b6f6-b123-4d2a-9602-cc26a9f61f83",
        name: "MetaMask",
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 35 33'><path fill='%23E17726' d='M32.96 1l-13.14 9.72 2.45-5.73L32.96 1z'/></svg>",
        rdns: "io.metamask",
      };

      const announceProvider = () => {
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: Object.freeze({ info, provider }),
          }),
        );
      };

      window.addEventListener("eip6963:requestProvider", announceProvider);
      announceProvider();

      setTimeout(() => {
        emit("connect", { chainId: chainHex });
        emit("accountsChanged", [walletAddress]);
        announceProvider();
      }, 50);
    })();
  `;
}

type TypedDataPayload = Record<string, unknown>;

function parseTypedDataPayload(input: unknown): TypedDataPayload {
  if (typeof input === "string") {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Typed data payload must be a JSON object");
    }
    return parsed as TypedDataPayload;
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Typed data payload must be an object");
  }

  return input as TypedDataPayload;
}

async function readWalletState(page: Page): Promise<WalletTestState | null> {
  return page.evaluate(() => {
    const pageGlobal = globalThis as {
      __m1InjectedWalletState?: WalletTestState;
    };
    return pageGlobal.__m1InjectedWalletState ?? null;
  });
}

type ConnectWalletClickResult = {
  clicked: boolean;
  strategy: string;
  candidates: string[];
};

type WalletUiConnectionHints = {
  hasInjectedAddressLabel: boolean;
  candidates: string[];
};

type NetworkCallRecord = {
  kind: "response" | "requestfailed";
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  errorText?: string;
  responseBodySnippet?: string;
};

type NetworkObservation = {
  calls: NetworkCallRecord[];
  errors: NetworkCallRecord[];
};

async function readWalletUiConnectionHints(
  page: Page,
  address: string,
): Promise<WalletUiConnectionHints> {
  return page.evaluate((injectedAddress) => {
    type MaybeElement = {
      textContent?: string;
      getAttribute?: (name: string) => string | null;
      getBoundingClientRect?: () => { width?: number; height?: number };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
          PointerEvent?: new (
            type: string,
            init?: Record<string, unknown>,
          ) => Event;
          MouseEvent?: new (
            type: string,
            init?: Record<string, unknown>,
          ) => Event;
        };
      };
    };

    const normalized = injectedAddress.toLowerCase();
    const shortPrefix = normalized.slice(0, 6);
    const shortSuffix = normalized.slice(-4);
    const nodes = Array.from(
      document.querySelectorAll("button, [role='button'], a, div, span"),
    ) as MaybeElement[];

    const visibleTexts = nodes
      .filter((node) => {
        const rect = node.getBoundingClientRect?.();
        const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
        return (
          (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden"
        );
      })
      .map((node) => {
        const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const ariaLabel = node.getAttribute?.("aria-label") ?? "";
        return `${text} | aria=${ariaLabel}`.trim();
      })
      .filter(Boolean);

    const hasInjectedAddressLabel = visibleTexts.some((text) => {
      const lower = text.toLowerCase();
      return lower.includes(shortPrefix) && lower.includes(shortSuffix);
    });

    return {
      hasInjectedAddressLabel,
      candidates: visibleTexts
        .filter(
          (text) =>
            /wallet|connect|deposit|faucet|0x[a-f0-9]/i.test(text) ||
            text.toLowerCase().includes(shortPrefix),
        )
        .slice(0, 30),
    } satisfies WalletUiConnectionHints;
  }, address);
}

async function observeFetchXhrNetworkDuring(
  page: Page,
  action: () => Promise<void>,
  settleMs = 4_000,
): Promise<NetworkObservation> {
  const calls: NetworkCallRecord[] = [];
  const pendingResponseReads: Promise<void>[] = [];

  const onResponse = (
    response: Awaited<ReturnType<Page["waitForResponse"]>>,
  ) => {
    const request = response.request();
    const resourceType = request.resourceType();
    if (resourceType !== "fetch" && resourceType !== "xhr") {
      return;
    }
    const record: NetworkCallRecord = {
      kind: "response",
      url: response.url(),
      method: request.method(),
      resourceType,
      status: response.status(),
    };
    calls.push(record);

    if (response.status() >= 400) {
      pendingResponseReads.push(
        response
          .text()
          .then((bodyText) => {
            record.responseBodySnippet = bodyText.slice(0, 2_000);
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            record.responseBodySnippet = `[failed to read body] ${message}`;
          }),
      );
    }
  };

  const onRequestFailed = (
    request: Awaited<ReturnType<Page["waitForRequest"]>>,
  ) => {
    const resourceType = request.resourceType();
    if (resourceType !== "fetch" && resourceType !== "xhr") {
      return;
    }

    calls.push({
      kind: "requestfailed",
      url: request.url(),
      method: request.method(),
      resourceType,
      errorText: request.failure()?.errorText,
    });
  };

  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  try {
    await action();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  } finally {
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
  }

  await Promise.allSettled(pendingResponseReads);

  const errors = calls.filter((call) => {
    if (call.kind === "requestfailed") {
      return true;
    }
    return (call.status ?? 0) >= 400;
  });

  return { calls, errors };
}

async function setTradingPanelSizeInput(
  page: Page,
  sizeValue: string,
): Promise<{
  inputFound: boolean;
  buyButtonFound: boolean;
  valueAfterSet: string;
}> {
  await page
    .waitForFunction(
      () => {
        const inputs = Array.from(document.querySelectorAll("input"));
        const visibleInputExists = inputs.some((input) => {
          const rect = input.getBoundingClientRect();
          const style = window.getComputedStyle(input);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        });

        const buttons = Array.from(document.querySelectorAll("button"));
        const visibleBuyButtonExists = buttons.some((button) => {
          const text =
            button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
          const rect = button.getBoundingClientRect();
          const style = window.getComputedStyle(button);
          return (
            /^buy(\s|$)/.test(text) &&
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        });

        return visibleInputExists && visibleBuyButtonExists;
      },
      { timeout: 40_000, polling: 200 },
    )
    .catch(() => undefined);

  return page.evaluate((nextSizeValue) => {
    type MaybeInput = {
      value?: string;
      focus?: () => void;
      blur?: () => void;
      dispatchEvent?: (event: Event) => boolean;
      getAttribute?: (name: string) => string | null;
      placeholder?: string | null;
      textContent?: string;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
        top?: number;
      };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
      closest?: (selector: string) => MaybeNode | null;
    };
    type MaybeButton = {
      textContent?: string;
      click?: () => void;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
        top?: number;
      };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
          PointerEvent?: new (
            type: string,
            init?: Record<string, unknown>,
          ) => Event;
          MouseEvent?: new (
            type: string,
            init?: Record<string, unknown>,
          ) => Event;
        };
      };
    };
    type MaybeNode = { textContent?: string; parentElement?: MaybeNode | null };

    const inputs = Array.from(
      document.querySelectorAll("input"),
    ) as MaybeInput[];
    const visibleInputs = inputs.filter((input) => {
      const rect = input.getBoundingClientRect?.();
      const style = input.ownerDocument?.defaultView?.getComputedStyle?.(input);
      return Boolean(
        (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden",
      );
    });
    const sizeInput =
      visibleInputs.find((input) => {
        const placeholder = (
          input.placeholder ??
          input.getAttribute?.("placeholder") ??
          ""
        ).toLowerCase();
        const ariaLabel = (
          input.getAttribute?.("aria-label") ?? ""
        ).toLowerCase();
        const nearbyText = (
          input.closest?.("div")?.textContent ?? ""
        ).toLowerCase();
        return (
          placeholder.includes("size") ||
          ariaLabel.includes("size") ||
          nearbyText.includes("size")
        );
      }) ?? visibleInputs[0];

    if (!sizeInput) {
      return { inputFound: false, buyButtonFound: false, valueAfterSet: "" };
    }

    sizeInput.focus?.();
    const inputProto = window.HTMLInputElement?.prototype;
    const valueSetter = inputProto
      ? Object.getOwnPropertyDescriptor(inputProto, "value")?.set
      : undefined;
    if (valueSetter) {
      valueSetter.call(sizeInput, nextSizeValue);
    } else {
      sizeInput.value = nextSizeValue;
    }
    sizeInput.dispatchEvent?.(new Event("input", { bubbles: true }));
    sizeInput.dispatchEvent?.(new Event("change", { bubbles: true }));
    sizeInput.blur?.();

    const valueAfterSet = sizeInput.value ?? "";

    const buttons = Array.from(
      document.querySelectorAll("button"),
    ) as MaybeButton[];
    const buyButtons = buttons
      .filter((button) => {
        const rect = button.getBoundingClientRect?.();
        const style =
          button.ownerDocument?.defaultView?.getComputedStyle?.(button);
        return Boolean(
          (rect?.width ?? 0) > 0 &&
            (rect?.height ?? 0) > 0 &&
            style?.display !== "none" &&
            style?.visibility !== "hidden",
        );
      })
      .filter((button) => {
        const text =
          button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
        return /^buy(\s|$)/.test(text);
      });

    const buyButton = buyButtons.sort((a, b) => {
      const aTop = a.getBoundingClientRect?.().top ?? 0;
      const bTop = b.getBoundingClientRect?.().top ?? 0;
      return bTop - aTop;
    })[0];

    if (!buyButton) {
      return { inputFound: true, buyButtonFound: false, valueAfterSet };
    }

    return { inputFound: true, buyButtonFound: true, valueAfterSet };
  }, sizeValue);
}

async function clickTradingPanelBuyButton(
  page: Page,
): Promise<{ buyButtonFound: boolean; clicked: boolean }> {
  return page.evaluate(() => {
    type MaybeButton = {
      textContent?: string;
      click?: () => void;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
        top?: number;
      };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const buttons = Array.from(
      document.querySelectorAll("button"),
    ) as MaybeButton[];
    const buyButtons = buttons
      .filter((button) => {
        const rect = button.getBoundingClientRect?.();
        const style =
          button.ownerDocument?.defaultView?.getComputedStyle?.(button);
        return Boolean(
          (rect?.width ?? 0) > 0 &&
            (rect?.height ?? 0) > 0 &&
            style?.display !== "none" &&
            style?.visibility !== "hidden",
        );
      })
      .filter((button) => {
        const text =
          button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
        return /^buy(\s|$)/.test(text);
      });

    const buyButton = buyButtons.sort((a, b) => {
      const aTop = a.getBoundingClientRect?.().top ?? 0;
      const bTop = b.getBoundingClientRect?.().top ?? 0;
      return bTop - aTop;
    })[0];

    if (!buyButton) {
      return { buyButtonFound: false, clicked: false };
    }

    buyButton.click?.();
    return { buyButtonFound: true, clicked: true };
  });
}

async function _clickAnyVisibleDepositButton(page: Page): Promise<{
  clicked: boolean;
  candidateLabels: string[];
}> {
  return page.evaluate(() => {
    type MaybeScope = {
      textContent?: string;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
    };
    type MaybeButton = {
      textContent?: string;
      click?: () => void;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
        top?: number;
      };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const headerScope =
      (document.querySelector("header") as MaybeScope | null) ??
      (document.querySelector('[role="banner"]') as MaybeScope | null) ??
      (document.querySelector("nav") as MaybeScope | null) ??
      (document as unknown as MaybeScope);

    const buttons = Array.from(
      headerScope.querySelectorAll?.("button") ?? [],
    ) as MaybeButton[] | [];
    const depositButtons = buttons
      .filter((button) => {
        const rect = button.getBoundingClientRect?.();
        const style =
          button.ownerDocument?.defaultView?.getComputedStyle?.(button);
        return Boolean(
          (rect?.width ?? 0) > 0 &&
            (rect?.height ?? 0) > 0 &&
            style?.display !== "none" &&
            style?.visibility !== "hidden",
        );
      })
      .filter((button) => {
        const text =
          button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
        return text === "deposit";
      });

    const candidateLabels = depositButtons
      .map((button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .slice(0, 10);

    // Header scope should only expose the top deposit button; click exactly that path.
    const target = depositButtons[0];

    target?.click?.();
    return { clicked: Boolean(target), candidateLabels };
  });
}

async function _waitForDepositModalVisible(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText?.toLowerCase() ?? "";
      return (
        bodyText.includes("deposit usdc from sei") ||
        (bodyText.includes("wallet balance") && bodyText.includes("deposit"))
      );
    },
    { timeout: timeoutMs, polling: 200 },
  );
}

async function _waitForDepositModalWalletBalance(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText ?? "";
      const match = bodyText.match(
        /wallet balance:\s*([0-9][0-9,\s]*(?:\.[0-9]+)?)\s*USDC/i,
      );
      if (!match?.[1]) {
        return false;
      }
      const parsed = Number(match[1].replaceAll(",", "").replace(/\s+/g, ""));
      return Number.isFinite(parsed) && parsed > 0;
    },
    { timeout: timeoutMs, polling: 250 },
  );
}

async function _fillDepositModalAmountPercent(
  page: Page,
  percent: number,
): Promise<{
  modalFound: boolean;
  walletBalanceFound: boolean;
  walletBalance: number | null;
  amountInputFound: boolean;
  amountValueAfterSet: string;
  computedAmount: string;
  depositButtonFound: boolean;
}> {
  return page.evaluate((pct) => {
    type MaybeContainer = {
      textContent?: string;
      parentElement?: MaybeContainer | null;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
        top?: number;
      };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };
    type MaybeButton = {
      textContent?: string;
      disabled?: boolean;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
        top?: number;
      };
      parentElement?: MaybeContainer | null;
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };
    type MaybeInput = {
      value?: string;
      focus?: () => void;
      blur?: () => void;
      dispatchEvent?: (event: Event) => boolean;
      disabled?: boolean;
      readOnly?: boolean;
      parentElement?: MaybeContainer | null;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
        top?: number;
      };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const visibleButtons = (
      Array.from(document.querySelectorAll("button")) as MaybeButton[]
    ).filter((button) => {
      const rect = button.getBoundingClientRect?.();
      const style =
        button.ownerDocument?.defaultView?.getComputedStyle?.(button);
      return Boolean(
        (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden",
      );
    });

    let modalRoot: MaybeContainer | null = null;
    let modalRootArea = Number.POSITIVE_INFINITY;
    for (const button of visibleButtons) {
      const text =
        button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
      if (text !== "cancel" && text !== "deposit") {
        continue;
      }

      let cursor = button.parentElement ?? null;
      for (let i = 0; i < 10 && cursor; i += 1) {
        const scopeText = (cursor.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const rect = cursor.getBoundingClientRect?.();
        const style =
          cursor.ownerDocument?.defaultView?.getComputedStyle?.(cursor);
        const visible =
          (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden";

        if (
          visible &&
          /deposit usdc from sei/i.test(scopeText) &&
          /wallet balance/i.test(scopeText)
        ) {
          const area = (rect?.width ?? 0) * (rect?.height ?? 0);
          const viewportArea = window.innerWidth * window.innerHeight;
          const looksTooLarge = area > viewportArea * 0.9;
          if (!looksTooLarge && area > 0 && area < modalRootArea) {
            modalRoot = cursor;
            modalRootArea = area;
          }
        }
        cursor = cursor.parentElement ?? null;
      }
    }

    const modalText = (modalRoot?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const modalFound = Boolean(modalRoot) && /deposit/i.test(modalText);

    const balanceMatch = modalText.match(
      /wallet balance:\s*([0-9][0-9,\s]*(?:\.[0-9]+)?)\s*USDC/i,
    );
    const walletBalance = balanceMatch?.[1]
      ? Number(balanceMatch[1].replaceAll(",", "").replace(/\s+/g, ""))
      : null;
    const walletBalanceFound =
      typeof walletBalance === "number" && Number.isFinite(walletBalance);

    const amount = walletBalanceFound ? walletBalance * pct : 0;
    const computedAmount = (() => {
      const fixed = amount.toFixed(6);
      return fixed.replace(/\.?0+$/, "");
    })();

    const visibleInputs = (
      Array.from(modalRoot?.querySelectorAll?.("input") ?? []) as MaybeInput[]
    )
      .filter((input) => {
        if (input.disabled || input.readOnly) {
          return false;
        }
        const rect = input.getBoundingClientRect?.();
        const style =
          input.ownerDocument?.defaultView?.getComputedStyle?.(input);
        return Boolean(
          (rect?.width ?? 0) > 0 &&
            (rect?.height ?? 0) > 0 &&
            style?.display !== "none" &&
            style?.visibility !== "hidden",
        );
      })
      .sort((a, b) => {
        const aTop = a.getBoundingClientRect?.().top ?? 0;
        const bTop = b.getBoundingClientRect?.().top ?? 0;
        return aTop - bTop;
      });

    let amountInput: MaybeInput | undefined;

    const maxButton = (
      Array.from(modalRoot?.querySelectorAll?.("button") ?? []) as MaybeButton[]
    )
      .filter((button) => !button.disabled)
      .find((button) => {
        const text =
          button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
        return text === "max";
      });

    if (maxButton) {
      let cursor = maxButton.parentElement ?? null;
      for (let i = 0; i < 8 && cursor; i += 1) {
        const rowInputs = Array.from(
          cursor.querySelectorAll?.("input") ?? [],
        ) as MaybeInput[];
        const visibleRowInput = rowInputs.find((input) => {
          if (input.disabled || input.readOnly) {
            return false;
          }
          const rect = input.getBoundingClientRect?.();
          const style =
            input.ownerDocument?.defaultView?.getComputedStyle?.(input);
          return Boolean(
            (rect?.width ?? 0) > 0 &&
              (rect?.height ?? 0) > 0 &&
              style?.display !== "none" &&
              style?.visibility !== "hidden",
          );
        });
        if (visibleRowInput) {
          amountInput = visibleRowInput;
          break;
        }
        cursor = cursor.parentElement ?? null;
      }
    }

    if (!amountInput) {
      for (const input of visibleInputs) {
        let cursor = input.parentElement ?? null;
        let scopeText = "";
        for (let i = 0; i < 8 && cursor; i += 1) {
          const candidateText = (cursor.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (candidateText) {
            scopeText = candidateText;
          }
          if (
            candidateText.includes("wallet balance") ||
            candidateText.includes("total")
          ) {
            scopeText = candidateText;
            break;
          }
          cursor = cursor.parentElement ?? null;
        }

        const looksLikeTotalField =
          scopeText.includes("total") && scopeText.includes("wallet balance");
        const looksLikeAssetField =
          scopeText.includes("asset") && !scopeText.includes("total");
        if (looksLikeTotalField) {
          amountInput = input;
          break;
        }
        if (!amountInput && !looksLikeAssetField) {
          amountInput = input;
        }
      }
    }
    amountInput ??= visibleInputs[0];
    if (amountInput && computedAmount) {
      amountInput.focus?.();
      const inputProto = window.HTMLInputElement?.prototype;
      const valueSetter = inputProto
        ? Object.getOwnPropertyDescriptor(inputProto, "value")?.set
        : undefined;
      if (valueSetter) {
        valueSetter.call(amountInput, computedAmount);
      } else {
        amountInput.value = computedAmount;
      }
      amountInput.dispatchEvent?.(new Event("input", { bubbles: true }));
      amountInput.dispatchEvent?.(new Event("change", { bubbles: true }));
    }

    const depositButtons = (
      Array.from(modalRoot?.querySelectorAll?.("button") ?? []) as MaybeButton[]
    )
      .filter((button) => !button.disabled)
      .filter((button) => {
        const text =
          button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
        return text === "deposit";
      });

    return {
      modalFound,
      walletBalanceFound,
      walletBalance: walletBalanceFound ? walletBalance : null,
      amountInputFound: Boolean(amountInput),
      amountValueAfterSet: amountInput?.value ?? "",
      computedAmount,
      depositButtonFound: depositButtons.length > 0,
    };
  }, percent);
}

async function _clickDepositModalSubmitButton(
  page: Page,
): Promise<{ clicked: boolean; candidates: string[]; clickedScope: string }> {
  return page.evaluate(() => {
    type MaybeContainer = {
      textContent?: string;
      parentElement?: MaybeContainer | null;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
      getBoundingClientRect?: () => { width?: number; height?: number };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };
    type MaybeButton = {
      textContent?: string;
      click?: () => void;
      disabled?: boolean;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
        top?: number;
      };
      parentElement?: MaybeContainer | null;
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const buttons = Array.from(
      document.querySelectorAll("button"),
    ) as MaybeButton[];
    const visibleButtons = buttons.filter((button) => {
      const rect = button.getBoundingClientRect?.();
      const style =
        button.ownerDocument?.defaultView?.getComputedStyle?.(button);
      return Boolean(
        (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden",
      );
    });

    let modalRoot: MaybeContainer | null = null;
    for (const button of visibleButtons) {
      const text =
        button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
      if (text !== "cancel" && text !== "deposit") {
        continue;
      }
      let cursor = button.parentElement ?? null;
      for (let i = 0; i < 10 && cursor; i += 1) {
        const scopeText = (cursor.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const rect = cursor.getBoundingClientRect?.();
        const style =
          cursor.ownerDocument?.defaultView?.getComputedStyle?.(cursor);
        const visible =
          (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden";
        if (
          visible &&
          /deposit usdc from sei/i.test(scopeText) &&
          /wallet balance/i.test(scopeText)
        ) {
          modalRoot = cursor;
          break;
        }
        cursor = cursor.parentElement ?? null;
      }
      if (modalRoot) {
        break;
      }
    }

    const depositButtons = (
      Array.from(modalRoot?.querySelectorAll?.("button") ?? []) as MaybeButton[]
    )
      .filter((button) => !button.disabled)
      .filter((button) => {
        const text =
          button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
        return text === "deposit";
      });

    const candidates = depositButtons.map(
      (button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "",
    );

    const target = depositButtons.sort((a, b) => {
      const aTop = a.getBoundingClientRect?.().top ?? 0;
      const bTop = b.getBoundingClientRect?.().top ?? 0;
      return bTop - aTop;
    })[0];

    let clickedScope = "";
    if (target) {
      let cursor = target.parentElement ?? null;
      for (let i = 0; i < 8 && cursor; i += 1) {
        const scopeText = (cursor.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (scopeText) {
          clickedScope = scopeText;
        }
        if (
          /deposit usdc from sei/i.test(scopeText) &&
          /wallet balance/i.test(scopeText)
        ) {
          clickedScope = scopeText;
          break;
        }
        cursor = cursor.parentElement ?? null;
      }
    }

    target?.click?.();
    return { clicked: Boolean(target), candidates, clickedScope };
  });
}

async function runReplayDepositModalSteps(page: Page): Promise<void> {
  const timeout = 5_000;

  await Locator.race([
    page.locator("::-p-aria(0.0)"),
    page.locator("#radix-_r_1o_ input"),
    page.locator(
      '::-p-xpath(//*[@id=\\"radix-_r_1o_\\"]/div[2]/div/div[1]/input)',
    ),
    page.locator(":scope >>> #radix-_r_1o_ input"),
  ])
    .setTimeout(timeout)
    .click({
      offset: {
        x: 209.73806762695312,
        y: 11.816925048828125,
      },
    });

  await Locator.race([
    page.locator("::-p-aria(0.0)"),
    page.locator("#radix-_r_1o_ input"),
    page.locator(
      '::-p-xpath(//*[@id=\\"radix-_r_1o_\\"]/div[2]/div/div[1]/input)',
    ),
    page.locator(":scope >>> #radix-_r_1o_ input"),
  ])
    .setTimeout(timeout)
    .fill("100");

  await Locator.race([
    page.locator('::-p-aria([role=\\"dialog\\"]) >>>> ::-p-aria(Deposit)'),
    page.locator("#radix-_r_1o_ button.bg-brand-accent"),
    page.locator('::-p-xpath(//*[@id=\\"radix-_r_1o_\\"]/div[3]/button[2])'),
    page.locator(":scope >>> #radix-_r_1o_ button.bg-brand-accent"),
  ])
    .setTimeout(timeout)
    .click({
      offset: {
        x: 46.67852783203125,
        y: 11.90618896484375,
      },
    });
}

async function _readDepositModalTotalInputValue(
  page: Page,
): Promise<string | null> {
  return page.evaluate(() => {
    type MaybeContainer = {
      textContent?: string;
      parentElement?: MaybeContainer | null;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
      getBoundingClientRect?: () => { width?: number; height?: number };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };
    type MaybeInput = {
      value?: string;
      parentElement?: MaybeContainer | null;
      disabled?: boolean;
      readOnly?: boolean;
      getBoundingClientRect?: () => { width?: number; height?: number };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };
    type MaybeButton = {
      textContent?: string;
      parentElement?: MaybeContainer | null;
      getBoundingClientRect?: () => { width?: number; height?: number };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const visibleButtons = (
      Array.from(document.querySelectorAll("button")) as MaybeButton[]
    ).filter((button) => {
      const rect = button.getBoundingClientRect?.();
      const style =
        button.ownerDocument?.defaultView?.getComputedStyle?.(button);
      return Boolean(
        (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden",
      );
    });

    let modalRoot: MaybeContainer | null = null;
    for (const button of visibleButtons) {
      const text =
        button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
      if (text !== "cancel" && text !== "deposit") {
        continue;
      }
      let cursor = button.parentElement ?? null;
      for (let i = 0; i < 10 && cursor; i += 1) {
        const scopeText = (cursor.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const rect = cursor.getBoundingClientRect?.();
        const style =
          cursor.ownerDocument?.defaultView?.getComputedStyle?.(cursor);
        const visible =
          (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden";
        if (
          visible &&
          /deposit usdc from sei/i.test(scopeText) &&
          /wallet balance/i.test(scopeText)
        ) {
          modalRoot = cursor;
          break;
        }
        cursor = cursor.parentElement ?? null;
      }
      if (modalRoot) {
        break;
      }
    }

    const inputs = (
      Array.from(modalRoot?.querySelectorAll?.("input") ?? []) as MaybeInput[]
    ).filter((input) => {
      if (input.disabled || input.readOnly) {
        return false;
      }
      const rect = input.getBoundingClientRect?.();
      const style = input.ownerDocument?.defaultView?.getComputedStyle?.(input);
      return Boolean(
        (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden",
      );
    });

    const maxButton = (
      Array.from(modalRoot?.querySelectorAll?.("button") ?? []) as MaybeButton[]
    ).find((button) => {
      const text =
        button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
      return text === "max";
    });

    if (maxButton) {
      let cursor = maxButton.parentElement ?? null;
      for (let i = 0; i < 8 && cursor; i += 1) {
        const rowInputs = Array.from(
          cursor.querySelectorAll?.("input") ?? [],
        ) as MaybeInput[];
        const visibleRowInput = rowInputs.find((input) => {
          if (input.disabled || input.readOnly) {
            return false;
          }
          const rect = input.getBoundingClientRect?.();
          const style =
            input.ownerDocument?.defaultView?.getComputedStyle?.(input);
          return Boolean(
            (rect?.width ?? 0) > 0 &&
              (rect?.height ?? 0) > 0 &&
              style?.display !== "none" &&
              style?.visibility !== "hidden",
          );
        });
        if (visibleRowInput) {
          return visibleRowInput.value ?? null;
        }
        cursor = cursor.parentElement ?? null;
      }
    }

    for (const input of inputs) {
      let cursor = input.parentElement ?? null;
      let scopeText = "";
      for (let i = 0; i < 8 && cursor; i += 1) {
        const candidate = (cursor.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (candidate) {
          scopeText = candidate;
        }
        if (
          candidate.includes("wallet balance") ||
          candidate.includes("total")
        ) {
          scopeText = candidate;
          break;
        }
        cursor = cursor.parentElement ?? null;
      }
      if (scopeText.includes("total") && scopeText.includes("wallet balance")) {
        return input.value ?? null;
      }
    }

    return inputs[0]?.value ?? null;
  });
}

async function _waitForDepositModalSettled(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const bodyText = document.body?.innerText?.toLowerCase() ?? "";
        const modalStillVisible =
          bodyText.includes("deposit usdc from sei") &&
          bodyText.includes("wallet balance");
        return !modalStillVisible;
      },
      { timeout: timeoutMs, polling: 250 },
    )
    .catch(() => undefined);
}

async function readCurrentTradePrice(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    type MaybeButton = {
      textContent?: string;
      getAttribute?: (name: string) => string | null;
    };

    const buttons = Array.from(
      document.querySelectorAll("button"),
    ) as MaybeButton[];
    for (const button of buttons) {
      const label = (
        button.getAttribute?.("aria-label") ??
        button.textContent ??
        ""
      ).trim();
      const match = label.match(/copy\s+(?:bid|ask)\s+price\s+([\d,.]+)/i);
      if (match?.[1]) {
        const parsed = Number(match[1].replaceAll(",", ""));
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed;
        }
      }
    }

    const bodyText = document.body?.innerText ?? "";
    const priceBlockMatch = bodyText.match(/PRICE\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
    if (priceBlockMatch?.[1]) {
      const parsed = Number(priceBlockMatch[1].replaceAll(",", ""));
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  });
}

async function clickTradePanelModeTab(
  page: Page,
  tabText: "Market" | "Limit",
): Promise<boolean> {
  return page.evaluate((label) => {
    type MaybeNode = {
      textContent?: string;
      focus?: () => void;
      click?: () => void;
      dispatchEvent?: (event: Event) => boolean;
      getAttribute?: (name: string) => string | null;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
      getBoundingClientRect?: () => { width?: number; height?: number };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const tablists = Array.from(
      document.querySelectorAll('[role="tablist"]'),
    ) as MaybeNode[];
    const tradeTablist = tablists.find((tablist) => {
      const tabs = Array.from(
        tablist.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
      if (!(labels.includes("Market") && labels.includes("Limit"))) {
        return false;
      }

      const visibleTabs = tabs.filter((tab) => {
        const rect = tab.getBoundingClientRect?.();
        const style = tab.ownerDocument?.defaultView?.getComputedStyle?.(tab);
        return (
          (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden"
        );
      });

      return visibleTabs.length >= 2;
    });

    const tabs = Array.from(
      tradeTablist?.querySelectorAll?.('[role="tab"]') ?? [],
    ) as MaybeNode[];
    const targetTab = tabs.find((tab) => tab.textContent?.trim() === label);
    if (!targetTab) {
      return false;
    }

    const rect = targetTab.getBoundingClientRect?.();
    const style =
      targetTab.ownerDocument?.defaultView?.getComputedStyle?.(targetTab);
    const visible =
      (rect?.width ?? 0) > 0 &&
      (rect?.height ?? 0) > 0 &&
      style?.display !== "none" &&
      style?.visibility !== "hidden";

    if (!visible) {
      return false;
    }

    targetTab.focus?.();

    const pointerEventCtor = window.PointerEvent;
    const mouseEventCtor = window.MouseEvent;
    const commonInit = { bubbles: true, cancelable: true, composed: true };

    if (pointerEventCtor) {
      targetTab.dispatchEvent?.(
        new pointerEventCtor("pointerdown", commonInit),
      );
      targetTab.dispatchEvent?.(new pointerEventCtor("pointerup", commonInit));
    }
    if (mouseEventCtor) {
      targetTab.dispatchEvent?.(new mouseEventCtor("mousedown", commonInit));
      targetTab.dispatchEvent?.(new mouseEventCtor("mouseup", commonInit));
      targetTab.dispatchEvent?.(new mouseEventCtor("click", commonInit));
    } else {
      targetTab.click?.();
    }

    return true;
  }, tabText);
}

async function waitForTradePanelModeTabSelected(
  page: Page,
  tabText: "Market" | "Limit",
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    (label) => {
      type MaybeNode = {
        textContent?: string;
        getAttribute?: (name: string) => string | null;
        querySelectorAll?: (selector: string) => Iterable<unknown>;
      };

      const tablists = Array.from(
        document.querySelectorAll('[role="tablist"]'),
      ) as MaybeNode[] | [];
      const tradeTablist = tablists.find((tablist) => {
        const tabs = Array.from(
          tablist.querySelectorAll?.('[role="tab"]') ?? [],
        ) as MaybeNode[];
        const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
        if (!(labels.includes("Market") && labels.includes("Limit"))) {
          return false;
        }

        const visibleTabs = tabs.filter((tab) => {
          const rect = (tab as Element).getBoundingClientRect?.();
          const style = window.getComputedStyle(tab as Element);
          return (
            (rect?.width ?? 0) > 0 &&
            (rect?.height ?? 0) > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        });

        return visibleTabs.length >= 2;
      });
      if (!tradeTablist) {
        return false;
      }

      const tabs = Array.from(
        tradeTablist.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const targetTab = tabs.find((tab) => tab.textContent?.trim() === label);
      if (!targetTab) {
        return false;
      }

      const panelId = targetTab.getAttribute?.("aria-controls") ?? "";
      const panel = panelId ? document.getElementById(panelId) : null;

      const tabSelected =
        targetTab.getAttribute?.("aria-selected") === "true" ||
        targetTab.getAttribute?.("data-state") === "active";
      const panelVisible = panel
        ? !panel.hasAttribute("hidden") &&
          window.getComputedStyle(panel).display !== "none"
        : false;

      return tabSelected && panelVisible;
    },
    { timeout: timeoutMs, polling: 200 },
    tabText,
  );
}

async function setLimitPanelPriceAndSize(
  page: Page,
  priceValue: string,
  sizeValue: string,
): Promise<{
  panelFound: boolean;
  priceInputFound: boolean;
  sizeInputFound: boolean;
  buyButtonFound: boolean;
  priceValueAfterSet: string;
  sizeValueAfterSet: string;
}> {
  return page.evaluate(
    (nextPriceValue, nextSizeValue) => {
      type MaybeInput = {
        value?: string;
        focus?: () => void;
        blur?: () => void;
        dispatchEvent?: (event: Event) => boolean;
        getBoundingClientRect?: () => { width?: number; height?: number };
        ownerDocument?: {
          defaultView?: {
            getComputedStyle?: (el: unknown) => {
              display?: string;
              visibility?: string;
            };
          };
        };
        disabled?: boolean;
        readOnly?: boolean;
      };
      type MaybeNode = {
        textContent?: string;
        getAttribute?: (name: string) => string | null;
        querySelectorAll?: (selector: string) => Iterable<unknown>;
      };
      type MaybeButton = {
        textContent?: string;
        getBoundingClientRect?: () => {
          width?: number;
          height?: number;
          top?: number;
        };
        ownerDocument?: {
          defaultView?: {
            getComputedStyle?: (el: unknown) => {
              display?: string;
              visibility?: string;
            };
          };
        };
      };

      const tablists = Array.from(
        document.querySelectorAll('[role="tablist"]'),
      ) as MaybeNode[] | [];
      const tradeTablist = tablists.find((tablist) => {
        const tabs = Array.from(
          tablist.querySelectorAll?.('[role="tab"]') ?? [],
        ) as MaybeNode[];
        const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
        return labels.includes("Market") && labels.includes("Limit");
      });
      const tabs = Array.from(
        tradeTablist?.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const limitTab = tabs.find((tab) => tab.textContent?.trim() === "Limit");
      const panelId = limitTab?.getAttribute?.("aria-controls") ?? "";
      const panel = panelId ? document.getElementById(panelId) : null;
      if (!panel) {
        return {
          panelFound: false,
          priceInputFound: false,
          sizeInputFound: false,
          buyButtonFound: false,
          priceValueAfterSet: "",
          sizeValueAfterSet: "",
        };
      }

      const allInputs = Array.from(
        panel.querySelectorAll("input, [role='spinbutton']"),
      ) as MaybeInput[];
      const visibleInputs = allInputs.filter((input) => {
        if (input.disabled || input.readOnly) {
          return false;
        }
        const rect = input.getBoundingClientRect?.();
        const style =
          input.ownerDocument?.defaultView?.getComputedStyle?.(input);
        return Boolean(
          (rect?.width ?? 0) > 0 &&
            (rect?.height ?? 0) > 0 &&
            style?.display !== "none" &&
            style?.visibility !== "hidden",
        );
      });

      const priceInput = visibleInputs[0];
      const sizeInput = visibleInputs[1];

      if (priceInput) {
        priceInput.focus?.();
        const inputProto = window.HTMLInputElement?.prototype;
        const valueSetter = inputProto
          ? Object.getOwnPropertyDescriptor(inputProto, "value")?.set
          : undefined;
        if (valueSetter) {
          valueSetter.call(priceInput, nextPriceValue);
        } else {
          priceInput.value = nextPriceValue;
        }
        priceInput.dispatchEvent?.(new Event("input", { bubbles: true }));
        priceInput.dispatchEvent?.(new Event("change", { bubbles: true }));
        priceInput.blur?.();
      }

      if (sizeInput) {
        sizeInput.focus?.();
        const inputProto = window.HTMLInputElement?.prototype;
        const valueSetter = inputProto
          ? Object.getOwnPropertyDescriptor(inputProto, "value")?.set
          : undefined;
        if (valueSetter) {
          valueSetter.call(sizeInput, nextSizeValue);
        } else {
          sizeInput.value = nextSizeValue;
        }
        sizeInput.dispatchEvent?.(new Event("input", { bubbles: true }));
        sizeInput.dispatchEvent?.(new Event("change", { bubbles: true }));
        sizeInput.blur?.();
      }

      const buyButton = (
        Array.from(panel.querySelectorAll("button")) as MaybeButton[]
      )
        .filter((button) => {
          const rect = button.getBoundingClientRect?.();
          const style =
            button.ownerDocument?.defaultView?.getComputedStyle?.(button);
          return Boolean(
            (rect?.width ?? 0) > 0 &&
              (rect?.height ?? 0) > 0 &&
              style?.display !== "none" &&
              style?.visibility !== "hidden",
          );
        })
        .filter((button) => {
          const text =
            button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
          return /^buy(\s|$)/.test(text);
        })
        .sort((a, b) => {
          const aTop = a.getBoundingClientRect?.().top ?? 0;
          const bTop = b.getBoundingClientRect?.().top ?? 0;
          return bTop - aTop;
        })[0];

      return {
        panelFound: true,
        priceInputFound: Boolean(priceInput),
        sizeInputFound: Boolean(sizeInput),
        buyButtonFound: Boolean(buyButton),
        priceValueAfterSet: priceInput?.value ?? "",
        sizeValueAfterSet: sizeInput?.value ?? "",
      };
    },
    priceValue,
    sizeValue,
  );
}

async function clickLimitPanelBuySubmit(
  page: Page,
): Promise<{ buyButtonFound: boolean; clicked: boolean }> {
  return page.evaluate(() => {
    type MaybeNode = {
      textContent?: string;
      getAttribute?: (name: string) => string | null;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
    };
    type MaybeButton = {
      textContent?: string;
      click?: () => void;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
        top?: number;
      };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const tablists = Array.from(
      document.querySelectorAll('[role="tablist"]'),
    ) as MaybeNode[] | [];
    const tradeTablist = tablists.find((tablist) => {
      const tabs = Array.from(
        tablist.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
      return labels.includes("Market") && labels.includes("Limit");
    });
    const tabs = Array.from(
      tradeTablist?.querySelectorAll?.('[role="tab"]') ?? [],
    ) as MaybeNode[];
    const limitTab = tabs.find((tab) => tab.textContent?.trim() === "Limit");
    const panelId = limitTab?.getAttribute?.("aria-controls") ?? "";
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!panel) {
      return { buyButtonFound: false, clicked: false };
    }

    const buyButton = (
      Array.from(panel.querySelectorAll("button")) as MaybeButton[]
    )
      .filter((button) => {
        const rect = button.getBoundingClientRect?.();
        const style =
          button.ownerDocument?.defaultView?.getComputedStyle?.(button);
        return Boolean(
          (rect?.width ?? 0) > 0 &&
            (rect?.height ?? 0) > 0 &&
            style?.display !== "none" &&
            style?.visibility !== "hidden",
        );
      })
      .filter((button) => {
        const text =
          button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
        return /^buy(\s|$)/.test(text);
      })
      .sort((a, b) => {
        const aTop = a.getBoundingClientRect?.().top ?? 0;
        const bTop = b.getBoundingClientRect?.().top ?? 0;
        return bTop - aTop;
      })[0];

    if (!buyButton) {
      return { buyButtonFound: false, clicked: false };
    }
    buyButton.click?.();
    return { buyButtonFound: true, clicked: true };
  });
}

async function clickAccountBottomTab(
  page: Page,
  tabText:
    | "Balances"
    | "Positions"
    | "Open Orders"
    | "Order History"
    | "Trade History"
    | "Funding History",
): Promise<boolean> {
  return page.evaluate((label) => {
    type MaybeNode = {
      textContent?: string;
      focus?: () => void;
      click?: () => void;
      dispatchEvent?: (event: Event) => boolean;
      scrollIntoView?: (options?: unknown) => void;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
      getBoundingClientRect?: () => { width?: number; height?: number };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const tablists = Array.from(
      document.querySelectorAll('[role="tablist"]'),
    ) as MaybeNode[] | [];
    const accountTablist = tablists.find((tablist) => {
      const tabs = Array.from(
        tablist.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
      if (!(labels.includes("Balances") && labels.includes("Open Orders"))) {
        return false;
      }

      const visibleTabs = tabs.filter((tab) => {
        const rect = tab.getBoundingClientRect?.();
        const style = tab.ownerDocument?.defaultView?.getComputedStyle?.(tab);
        return (
          (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden"
        );
      });

      return visibleTabs.length >= 2;
    });
    const tabs = Array.from(
      accountTablist?.querySelectorAll?.('[role="tab"]') ?? [],
    ) as MaybeNode[];
    const targetTab = tabs.find((tab) => tab.textContent?.trim() === label);
    if (!targetTab) {
      return false;
    }

    const rect = targetTab.getBoundingClientRect?.();
    const style =
      targetTab.ownerDocument?.defaultView?.getComputedStyle?.(targetTab);
    const visible =
      (rect?.width ?? 0) > 0 &&
      (rect?.height ?? 0) > 0 &&
      style?.display !== "none" &&
      style?.visibility !== "hidden";
    if (!visible) {
      return false;
    }

    targetTab.scrollIntoView?.({ block: "center", inline: "nearest" });
    targetTab.focus?.();

    const pointerEventCtor = window.PointerEvent;
    const mouseEventCtor = window.MouseEvent;
    const commonInit = { bubbles: true, cancelable: true, composed: true };

    if (pointerEventCtor) {
      targetTab.dispatchEvent?.(
        new pointerEventCtor("pointerdown", commonInit),
      );
      targetTab.dispatchEvent?.(new pointerEventCtor("pointerup", commonInit));
    }
    if (mouseEventCtor) {
      targetTab.dispatchEvent?.(new mouseEventCtor("mousedown", commonInit));
      targetTab.dispatchEvent?.(new mouseEventCtor("mouseup", commonInit));
      targetTab.dispatchEvent?.(new mouseEventCtor("click", commonInit));
    } else {
      targetTab.click?.();
    }

    return true;
  }, tabText);
}

async function waitForAccountBottomTabSelected(
  page: Page,
  tabText:
    | "Balances"
    | "Positions"
    | "Open Orders"
    | "Order History"
    | "Trade History"
    | "Funding History",
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    (label) => {
      type MaybeNode = {
        textContent?: string;
        getAttribute?: (name: string) => string | null;
        querySelectorAll?: (selector: string) => Iterable<unknown>;
      };
      const tablists = Array.from(
        document.querySelectorAll('[role="tablist"]'),
      ) as MaybeNode[] | [];
      const accountTablist = tablists.find((tablist) => {
        const tabs = Array.from(
          tablist.querySelectorAll?.('[role="tab"]') ?? [],
        ) as MaybeNode[];
        const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
        if (!(labels.includes("Balances") && labels.includes("Open Orders"))) {
          return false;
        }

        const visibleTabs = tabs.filter((tab) => {
          const rect = (tab as Element).getBoundingClientRect?.();
          const style = window.getComputedStyle(tab as Element);
          return (
            (rect?.width ?? 0) > 0 &&
            (rect?.height ?? 0) > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        });

        return visibleTabs.length >= 2;
      });
      if (!accountTablist) {
        return false;
      }

      const tabs = Array.from(
        accountTablist.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const targetTab = tabs.find((tab) => tab.textContent?.trim() === label);
      if (!targetTab) {
        return false;
      }

      const panelId = targetTab.getAttribute?.("aria-controls") ?? "";
      const panel = panelId ? document.getElementById(panelId) : null;
      return Boolean(
        (targetTab.getAttribute?.("aria-selected") === "true" ||
          targetTab.getAttribute?.("data-state") === "active") &&
          panel &&
          !panel.hasAttribute("hidden") &&
          window.getComputedStyle(panel).display !== "none",
      );
    },
    { timeout: timeoutMs, polling: 200 },
    tabText,
  );
}

async function waitForOpenOrderPriceVisible(
  page: Page,
  targetPrice: number,
  timeoutMs: number,
): Promise<void> {
  const normalizedPrice = targetPrice.toFixed(2);
  await page.waitForFunction(
    (priceText) => {
      type MaybeNode = {
        textContent?: string;
        getAttribute?: (name: string) => string | null;
        querySelectorAll?: (selector: string) => Iterable<unknown>;
      };
      const normalizedNeedle = priceText.replaceAll(",", "");
      const tablists = Array.from(
        document.querySelectorAll('[role="tablist"]'),
      ) as MaybeNode[] | [];
      const accountTablist = tablists.find((tablist) => {
        const tabs = Array.from(
          tablist.querySelectorAll?.('[role="tab"]') ?? [],
        ) as MaybeNode[];
        const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
        return labels.includes("Balances") && labels.includes("Open Orders");
      });
      const tabs = Array.from(
        accountTablist?.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const openOrdersTab = tabs.find(
        (tab) => tab.textContent?.trim() === "Open Orders",
      );
      const panelId = openOrdersTab?.getAttribute?.("aria-controls") ?? "";
      const panel = panelId ? document.getElementById(panelId) : null;
      if (!panel) {
        return false;
      }
      const text = (panel.textContent ?? "").replaceAll(",", "");
      return text.includes(normalizedNeedle);
    },
    { timeout: timeoutMs, polling: 250 },
    normalizedPrice,
  );
}

async function cancelOpenOrderByPrice(
  page: Page,
  targetPrice: number,
): Promise<{
  cancelButtonFound: boolean;
  clicked: boolean;
  debugCandidates: string[];
}> {
  return page.evaluate((priceValue) => {
    type MaybeNode = {
      textContent?: string;
      getAttribute?: (name: string) => string | null;
      parentElement?: MaybeNode | null;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
      click?: () => void;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
        left?: number;
        top?: number;
      };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const targetPriceText = priceValue.toFixed(2).replaceAll(",", "");
    const tablists = Array.from(
      document.querySelectorAll('[role="tablist"]'),
    ) as MaybeNode[] | [];
    const accountTablist = tablists.find((tablist) => {
      const tabs = Array.from(
        tablist.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
      return labels.includes("Balances") && labels.includes("Open Orders");
    });
    const tabs = Array.from(
      accountTablist?.querySelectorAll?.('[role="tab"]') ?? [],
    ) as MaybeNode[];
    const openOrdersTab = tabs.find(
      (tab) => tab.textContent?.trim() === "Open Orders",
    );
    const panelId = openOrdersTab?.getAttribute?.("aria-controls") ?? "";
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!panel) {
      return { cancelButtonFound: false, clicked: false, debugCandidates: [] };
    }

    const allButtons = Array.from(
      panel.querySelectorAll("button"),
    ) as MaybeNode[];
    const visibleButtons = allButtons.filter((button) => {
      const rect = button.getBoundingClientRect?.();
      const style =
        button.ownerDocument?.defaultView?.getComputedStyle?.(button);
      return Boolean(
        (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden",
      );
    });

    const debugCandidates = visibleButtons
      .map((button) => {
        const text = button.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const aria = button.getAttribute?.("aria-label") ?? "";
        const title = button.getAttribute?.("title") ?? "";
        let scopeText = "";
        let cursor = button.parentElement;
        for (let i = 0; i < 5 && cursor; i += 1) {
          scopeText = (cursor.textContent ?? "").replace(/\s+/g, " ").trim();
          if (scopeText) {
            break;
          }
          cursor = cursor.parentElement ?? null;
        }
        return `${text || "<icon>"} | aria=${aria} | title=${title} | scope=${scopeText}`;
      })
      .slice(0, 40);

    const buttonsWithScope = visibleButtons.map((button) => {
      let scopeText = "";
      let cursor = button.parentElement;
      for (let i = 0; i < 8 && cursor; i += 1) {
        const candidateText = (cursor.textContent ?? "")
          .replace(/\s+/g, " ")
          .replaceAll(",", "")
          .trim();
        if (candidateText) {
          scopeText = candidateText;
        }
        if (
          candidateText.includes(targetPriceText) &&
          /(submitted|open|limit|buy)/i.test(candidateText)
        ) {
          scopeText = candidateText;
          break;
        }
        cursor = cursor.parentElement ?? null;
      }

      return { button, scopeText };
    });

    const targetButton = visibleButtons.find((button) => {
      const label = (
        (button.textContent ?? "") +
        " " +
        (button.getAttribute?.("aria-label") ?? "")
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!/cancel/.test(label)) {
        return false;
      }

      let cursor = button.parentElement;
      for (let i = 0; i < 6 && cursor; i += 1) {
        const scopeText = (cursor.textContent ?? "")
          .replace(/\s+/g, " ")
          .replaceAll(",", "")
          .toLowerCase();
        if (scopeText.includes(targetPriceText.toLowerCase())) {
          return true;
        }
        cursor = cursor.parentElement ?? null;
      }

      return false;
    });

    const rowIconButtons = buttonsWithScope
      .filter(({ button, scopeText }) => {
        if (!scopeText) {
          return false;
        }
        const normalizedScope = scopeText.toLowerCase();
        if (!normalizedScope.includes(targetPriceText.toLowerCase())) {
          return false;
        }
        const label = (
          (button.textContent ?? "") +
          " " +
          (button.getAttribute?.("aria-label") ?? "") +
          " " +
          (button.getAttribute?.("title") ?? "")
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (/previous|next/.test(label)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aRect = a.button.getBoundingClientRect?.();
        const bRect = b.button.getBoundingClientRect?.();
        const topDelta = (aRect?.top ?? 0) - (bRect?.top ?? 0);
        if (Math.abs(topDelta) > 4) {
          return topDelta;
        }
        return (aRect?.left ?? 0) - (bRect?.left ?? 0);
      });

    // In the current UI the row action buttons can be icon-only without an aria-label.
    // Prefer an explicit "cancel" match, otherwise use the rightmost action icon in the matching row.
    const fallbackCancelButton = visibleButtons.find((button) => {
      const label = (
        (button.textContent ?? "") +
        " " +
        (button.getAttribute?.("aria-label") ?? "") +
        " " +
        (button.getAttribute?.("title") ?? "")
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return /cancel/.test(label);
    });

    const chosen =
      targetButton ??
      rowIconButtons[rowIconButtons.length - 1]?.button ??
      fallbackCancelButton;
    if (!chosen) {
      return { cancelButtonFound: false, clicked: false, debugCandidates };
    }
    chosen.click?.();
    return { cancelButtonFound: true, clicked: true, debugCandidates };
  }, targetPrice);
}

async function confirmCancelOrderIfPromptVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    type MaybeButton = {
      textContent?: string;
      click?: () => void;
      getAttribute?: (name: string) => string | null;
      getBoundingClientRect?: () => { width?: number; height?: number };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const buttons = Array.from(
      document.querySelectorAll("button"),
    ) as MaybeButton[];
    const visibleButtons = buttons.filter((button) => {
      const rect = button.getBoundingClientRect?.();
      const style =
        button.ownerDocument?.defaultView?.getComputedStyle?.(button);
      return Boolean(
        (rect?.width ?? 0) > 0 &&
          (rect?.height ?? 0) > 0 &&
          style?.display !== "none" &&
          style?.visibility !== "hidden",
      );
    });

    const confirmButton = visibleButtons.find((button) => {
      const label = (
        (button.textContent ?? "") +
        " " +
        (button.getAttribute?.("aria-label") ?? "")
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return (
        /^confirm\b/.test(label) ||
        /\bcancel order\b/.test(label) ||
        /\byes\b/.test(label)
      );
    });

    confirmButton?.click?.();
    return Boolean(confirmButton);
  });
}

async function waitForOpenOrderPriceGone(
  page: Page,
  targetPrice: number,
  timeoutMs: number,
): Promise<void> {
  const normalizedPrice = targetPrice.toFixed(2);
  await page.waitForFunction(
    (priceText) => {
      type MaybeNode = {
        textContent?: string;
        getAttribute?: (name: string) => string | null;
        querySelectorAll?: (selector: string) => Iterable<unknown>;
      };
      const normalizedNeedle = priceText.replaceAll(",", "");
      const tablists = Array.from(
        document.querySelectorAll('[role="tablist"]'),
      ) as MaybeNode[] | [];
      const accountTablist = tablists.find((tablist) => {
        const tabs = Array.from(
          tablist.querySelectorAll?.('[role="tab"]') ?? [],
        ) as MaybeNode[];
        const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
        return labels.includes("Balances") && labels.includes("Open Orders");
      });
      const tabs = Array.from(
        accountTablist?.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const openOrdersTab = tabs.find(
        (tab) => tab.textContent?.trim() === "Open Orders",
      );
      const panelId = openOrdersTab?.getAttribute?.("aria-controls") ?? "";
      const panel = panelId ? document.getElementById(panelId) : null;
      if (!panel) {
        return false;
      }
      const text = (panel.textContent ?? "").replaceAll(",", "");
      if (/no open orders/i.test(text)) {
        return true;
      }
      return !text.includes(normalizedNeedle);
    },
    { timeout: timeoutMs, polling: 250 },
    normalizedPrice,
  );
}

async function isOpenOrderPriceVisibleNow(
  page: Page,
  targetPrice: number,
): Promise<boolean> {
  const normalizedPrice = targetPrice.toFixed(2);
  return page.evaluate((priceText) => {
    type MaybeNode = {
      textContent?: string;
      getAttribute?: (name: string) => string | null;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
    };
    const normalizedNeedle = priceText.replaceAll(",", "");
    const tablists = Array.from(
      document.querySelectorAll('[role="tablist"]'),
    ) as MaybeNode[] | [];
    const accountTablist = tablists.find((tablist) => {
      const tabs = Array.from(
        tablist.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
      return labels.includes("Balances") && labels.includes("Open Orders");
    });
    const tabs = Array.from(
      accountTablist?.querySelectorAll?.('[role="tab"]') ?? [],
    ) as MaybeNode[];
    const openOrdersTab = tabs.find(
      (tab) => tab.textContent?.trim() === "Open Orders",
    );
    const panelId = openOrdersTab?.getAttribute?.("aria-controls") ?? "";
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!panel) {
      return false;
    }
    const text = (panel.textContent ?? "").replaceAll(",", "");
    return text.includes(normalizedNeedle);
  }, normalizedPrice);
}

async function clickConnectWalletButton(
  page: Page,
): Promise<ConnectWalletClickResult> {
  await page
    .waitForFunction(
      () => {
        const nodes = Array.from(
          document.querySelectorAll("button, [role='button'], a, div"),
        );
        return nodes.some((node) => {
          const text =
            node.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
          const ariaLabel =
            node.getAttribute("aria-label")?.toLowerCase() ?? "";
          return (
            text.includes("connect wallet") ||
            text === "connect" ||
            ariaLabel.includes("connect wallet")
          );
        });
      },
      { timeout: 15_000 },
    )
    .catch(() => undefined);

  return page.evaluate(() => {
    type MaybeElement = {
      textContent?: string;
      click?: () => void;
      getAttribute?: (name: string) => string | null;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
      shadowRoot?: MaybeElement;
      getBoundingClientRect?: () => {
        width?: number;
        height?: number;
      };
      ownerDocument?: {
        defaultView?: {
          getComputedStyle?: (el: unknown) => {
            display?: string;
            visibility?: string;
          };
        };
      };
    };

    const nodes: MaybeElement[] = [];
    const rootsToVisit: MaybeElement[] = [document as unknown as MaybeElement];

    while (rootsToVisit.length > 0) {
      const root = rootsToVisit.pop();
      if (!root) {
        continue;
      }

      nodes.push(
        ...(Array.from(
          root.querySelectorAll?.("button, [role='button'], a, div") ?? [],
        ) as MaybeElement[]),
      );

      const allElements = Array.from(root.querySelectorAll?.("*") ?? []) as
        | MaybeElement[]
        | [];
      for (const el of allElements) {
        if (el.shadowRoot) {
          rootsToVisit.push(el.shadowRoot);
        }
      }
    }
    const candidates = nodes
      .map((node) => {
        const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const ariaLabel = node.getAttribute?.("aria-label") ?? "";
        return `${text} | aria=${ariaLabel}`.trim();
      })
      .filter((value) =>
        /connect|wallet|metamask|browser wallet|injected/i.test(value),
      )
      .slice(0, 20);

    const connectNode = nodes.find((node) => {
      const text =
        node.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
      const ariaLabel = node.getAttribute?.("aria-label")?.toLowerCase() ?? "";
      const rect = node.getBoundingClientRect?.();
      const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
      const visible =
        (rect?.width ?? 0) > 0 &&
        (rect?.height ?? 0) > 0 &&
        style?.display !== "none" &&
        style?.visibility !== "hidden";
      return (
        visible &&
        (text.includes("connect wallet") ||
          text === "connect" ||
          ariaLabel.includes("connect wallet"))
      );
    });

    if (!connectNode) {
      return {
        clicked: false,
        strategy: "no-connect-candidate",
        candidates,
      } satisfies ConnectWalletClickResult;
    }

    connectNode.click?.();
    return {
      clicked: true,
      strategy: "text-or-aria-match",
      candidates,
    } satisfies ConnectWalletClickResult;
  });
}

async function clickMetaMaskOptionIfVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    type MaybeNode = {
      textContent?: string;
      click?: () => void;
      offsetParent?: unknown | null;
    };

    const pageGlobal = globalThis as {
      document?: {
        querySelectorAll?: (selector: string) => Iterable<unknown>;
      };
    };

    const candidates = Array.from(
      pageGlobal.document?.querySelectorAll?.(
        "button, [role='button'], li, div",
      ) ?? [],
    ) as MaybeNode[];

    const option = candidates.find((node) => {
      const text =
        node.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
      const visible = node.offsetParent !== null;
      return (
        visible &&
        (text.includes("metamask") ||
          text.includes("browser wallet") ||
          text.includes("injected"))
      );
    });

    option?.click?.();
    return Boolean(option);
  });
}

type ScreenerLiveDataSummary = {
  uniquePairCount: number;
  percentCount: number;
  priceLikeCount: number;
  samplePairs: string[];
};

async function runReplayOpenScreener(page: Page): Promise<void> {
  const timeout = 5_000;
  await Locator.race([
    page.locator("::-p-aria(Screener)"),
    page.locator("header a:nth-of-type(2)"),
    page.locator("::-p-xpath(/html/body/div[2]/header/nav/div[1]/div/a[2])"),
    page.locator(":scope >>> header a:nth-of-type(2)"),
  ])
    .setTimeout(timeout)
    .click({
      offset: {
        x: 14.357131958007812,
        y: 12.999998092651367,
      },
    });
}

async function runReplayClickScreenerTab(
  page: Page,
  tab: "COOKING" | "EQUITIES" | "CRYPTO",
): Promise<void> {
  const timeout = 5_000;

  if (tab === "COOKING") {
    await Locator.race([
      page.locator("::-p-aria(COOKING)"),
      page.locator("div.border-border\\/80 > div > button:nth-of-type(1)"),
      page.locator(
        '::-p-xpath(//*[@id=\\"main-content\\"]/div[2]/div[1]/div/button[1])',
      ),
      page.locator(":scope >>> div.border-border\\/80 > div > button:nth-of-type(1)"),
      page.locator("::-p-text(Cooking)"),
    ])
      .setTimeout(timeout)
      .click({
        offset: {
          x: 19.67559051513672,
          y: 14.389862060546875,
        },
      });
    return;
  }

  if (tab === "EQUITIES") {
    await Locator.race([
      page.locator("::-p-aria(EQUITIES)"),
      page.locator("#main-content button:nth-of-type(2)"),
      page.locator(
        '::-p-xpath(//*[@id=\\"main-content\\"]/div[2]/div[1]/div/button[2])',
      ),
      page.locator(":scope >>> #main-content button:nth-of-type(2)"),
      page.locator("::-p-text(Equities)"),
    ])
      .setTimeout(timeout)
      .click({
        offset: {
          x: 35.24403381347656,
          y: 12.389862060546875,
        },
      });
    return;
  }

  await Locator.race([
    page.locator("::-p-aria(CRYPTO)"),
    page.locator("button:nth-of-type(3)"),
    page.locator(
      '::-p-xpath(//*[@id=\\"main-content\\"]/div[2]/div[1]/div/button[3])',
    ),
    page.locator(":scope >>> button:nth-of-type(3)"),
    page.locator("::-p-text(Crypto)"),
  ])
    .setTimeout(timeout)
    .click({
      offset: {
        x: 12.607131958007812,
        y: 12.389862060546875,
      },
    });
}

async function getScreenerLiveDataSummary(
  page: Page,
): Promise<ScreenerLiveDataSummary> {
  return page.evaluate(() => {
    const scope =
      (document.querySelector("#main-content") as HTMLElement | null) ??
      document.body;
    const text = scope?.innerText ?? "";
    const uniquePairs = Array.from(
      new Set(text.match(/\b[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}\b/g) ?? []),
    );
    const percentCount = (text.match(/[+\-−]?\d+(?:\.\d+)?%/g) ?? []).length;
    const priceLikeCount = (
      text.match(/\$?\d[\d,]*(?:\.\d+)?/g) ?? []
    ).length;

    return {
      uniquePairCount: uniquePairs.length,
      percentCount,
      priceLikeCount,
      samplePairs: uniquePairs.slice(0, 15),
    };
  });
}

async function waitForScreenerLiveData(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    () => {
      const scope =
        (document.querySelector("#main-content") as HTMLElement | null) ??
        document.body;
      const text = scope?.innerText ?? "";
      const uniquePairs = Array.from(
        new Set(text.match(/\b[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}\b/g) ?? []),
      );
      const percentCount = (text.match(/[+\-−]?\d+(?:\.\d+)?%/g) ?? []).length;
      const priceLikeCount = (text.match(/\$?\d[\d,]*(?:\.\d+)?/g) ?? []).length;
      const loading = /loading\.\.\./i.test(text);

      return (
        uniquePairs.length >= 1 &&
        percentCount >= 1 &&
        priceLikeCount >= 3 &&
        !loading
      );
    },
    { timeout: timeoutMs, polling: 200 },
  );
}

async function runReplayOpenSwap(page: Page): Promise<void> {
  const timeout = 5_000;
  await Locator.race([
    page.locator("::-p-aria(Swap)"),
    page.locator("header a:nth-of-type(3)"),
    page.locator("::-p-xpath(/html/body/div[2]/header/nav/div[1]/div/a[3])"),
    page.locator(":scope >>> header a:nth-of-type(3)"),
  ])
    .setTimeout(timeout)
    .click({
      offset: {
        x: 23.130935668945312,
        y: 8.999998092651367,
      },
    });
}

async function runReplayPrepareSwapUsdcBtc(
  page: Page,
  amount = "10",
): Promise<void> {
  const timeout = 5_000;

  await Locator.race([
    page.locator("div.pointer-events-none > button"),
    page.locator(
      '::-p-xpath(//*[@id=\\"main-content\\"]/div/div[2]/div[1]/div/div[2]/div/div[1]/div[2]/button)',
    ),
    page.locator(":scope >>> div.pointer-events-none > button"),
  ])
    .setTimeout(timeout)
    .click({
      offset: {
        x: 7.613067626953125,
        y: 29.34222412109375,
      },
    });

  await Locator.race([
    page.locator("::-p-aria(You pay amount)"),
    page.locator(
      "div:nth-of-type(1) > div > div:nth-of-type(2) > div > div.relative input",
    ),
    page.locator(
      '::-p-xpath(//*[@id=\\"main-content\\"]/div/div[2]/div[1]/div/div[2]/div/div[1]/div[1]/div/div[2]/input)',
    ),
    page.locator(
      ":scope >>> div:nth-of-type(1) > div > div:nth-of-type(2) > div > div.relative input",
    ),
  ])
    .setTimeout(timeout)
    .click({
      offset: {
        x: 314.73511505126953,
        y: 27.252960205078125,
      },
    });

  await Locator.race([
    page.locator("::-p-aria(You pay amount)"),
    page.locator(
      "div:nth-of-type(1) > div > div:nth-of-type(2) > div > div.relative input",
    ),
    page.locator(
      '::-p-xpath(//*[@id=\\"main-content\\"]/div/div[2]/div[1]/div/div[2]/div/div[1]/div[1]/div/div[2]/input)',
    ),
    page.locator(
      ":scope >>> div:nth-of-type(1) > div > div:nth-of-type(2) > div > div.relative input",
    ),
  ])
    .setTimeout(timeout)
    .fill(amount);
}

async function runReplaySubmitSwap(page: Page): Promise<void> {
  const timeout = 5_000;

  await Locator.race([
    page.locator('::-p-aria(Swap[role=\\"button\\"])'),
    page.locator("div.grid > div:nth-of-type(1) > div > button"),
    page.locator('::-p-xpath(//*[@id=\\"main-content\\"]/div/div[2]/div[1]/div/button)'),
    page.locator(":scope >>> div.grid > div:nth-of-type(1) > div > button"),
  ])
    .setTimeout(timeout)
    .click({
      offset: {
        x: 357.6845169067383,
        y: 25.16961669921875,
      },
    });
}

describe("puppeteer | app.m1.markets | injected wallet auth", function () {
  this.timeout(120_000);

  let browser: Browser | undefined;
  let page: Page | undefined;
  let injectedWalletAddress: `0x${string}` | undefined;

  before(async function () {
    await resetDebugScreenshotDir();

    if (process.env[ENABLE_ENV] !== "1") {
      this.skip();
    }

    const rawPrivateKey = process.env.WALLET_PRIVATE_KEY;
    if (!rawPrivateKey) {
      this.skip();
    }

    const normalizedPrivateKey = rawPrivateKey.startsWith("0x")
      ? rawPrivateKey
      : `0x${rawPrivateKey}`;
    const account = privateKeyToAccount(normalizedPrivateKey as `0x${string}`);
    injectedWalletAddress = account.address;

    browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    page = await browser.newPage();
    await page.setBypassCSP(true);
    await page.setViewport({ width: 1440, height: 900 });

    await page.exposeFunction("__m1SignPersonal", async (message: unknown) => {
      if (typeof message !== "string") {
        throw new Error("personal_sign message must be a string");
      }

      if (isHex(message)) {
        return account.signMessage({ message: { raw: hexToBytes(message) } });
      }

      return account.signMessage({ message });
    });

    await page.exposeFunction(
      "__m1SignTypedData",
      async (typedDataInput: unknown) => {
        const typedData = parseTypedDataPayload(typedDataInput);

        return account.signTypedData(
          typedData as Parameters<typeof account.signTypedData>[0],
        );
      },
    );

    await page.evaluateOnNewDocument(
      getWalletInjectionScript(account.address, CHAIN_ID),
    );
  });

  after(async function () {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  });

  afterEach(async function () {
    if (!page) {
      return;
    }

    const testTitle =
      this.currentTest?.fullTitle() ??
      this.currentTest?.title ??
      "wallet-auth-test";
    const state = this.currentTest?.state;
    await saveTestScreenshot(page, testTitle, state);
  });

  it("injects wallet provider and triggers connect-wallet auth flow", async function () {
    if (!page) {
      this.skip();
    }

    await page.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 40_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(page);

    if (isBotChallengePage(title, bodyText)) {
      this.skip();
    }

    await dismissWorkInProgressModal(page);
    await waitForRenderableUi(page);
    await dismissWorkInProgressModal(page);

    await saveTestScreenshot(
      page,
      "wallet-auth-before-authentication",
      "debug",
    );
    const initialWalletState = await readWalletState(page);
    assert.exists(
      initialWalletState,
      "expected injected wallet state on window",
    );

    let connectResult: ConnectWalletClickResult = {
      clicked: false,
      strategy: "not-attempted",
      candidates: [],
    };

    try {
      connectResult = await clickConnectWalletButton(page);

      if (!connectResult.clicked) {
        const walletUiHints = await readWalletUiConnectionHints(
          page,
          injectedWalletAddress ?? initialWalletState?.address ?? "0x",
        );
        assert.isTrue(
          walletUiHints.hasInjectedAddressLabel,
          `expected to click Connect Wallet button or find already-connected wallet UI (strategy=${connectResult.strategy}, clickCandidates=${JSON.stringify(connectResult.candidates)}, uiCandidates=${JSON.stringify(walletUiHints.candidates)})`,
        );
      }

      if (connectResult.clicked) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await clickMetaMaskOptionIfVisible(page).catch(() => false);

        await page
          .waitForFunction(
            () => {
              type MaybeNode = {
                textContent?: string;
                getAttribute?: (name: string) => string | null;
              };

              const pageGlobal = globalThis as {
                __m1InjectedWalletState?: WalletTestState;
                document?: {
                  querySelectorAll?: (selector: string) => Iterable<unknown>;
                };
              };

              const walletState = pageGlobal.__m1InjectedWalletState;
              const methods = walletState?.requestedMethods ?? [];
              const requestedAccounts = methods.includes("eth_requestAccounts");

              const nodes = Array.from(
                pageGlobal.document?.querySelectorAll?.(
                  "button, [role='button'], a",
                ) ?? [],
              ) as MaybeNode[];

              const connectTextStillVisible = nodes.some((node) => {
                const text =
                  node.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ??
                  "";
                return /connect wallet/.test(text) || /^connect$/i.test(text);
              });

              const modalWalletOptionVisible = nodes.some((node) => {
                const text =
                  node.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ??
                  "";
                return (
                  text.includes("metamask") ||
                  text.includes("browser wallet") ||
                  text.includes("injected")
                );
              });

              return (
                requestedAccounts ||
                modalWalletOptionVisible ||
                !connectTextStillVisible
              );
            },
            { timeout: 40_000 },
          )
          .catch(() => undefined);
      }
    } finally {
      await saveTestScreenshot(
        page,
        "wallet-auth-after-authentication",
        "debug",
      );
    }

    const finalWalletState = await readWalletState(page);
    const requestedMethods = finalWalletState?.requestedMethods ?? [];

    const accountsRequested = requestedMethods.includes("eth_requestAccounts");
    const chainRequested = requestedMethods.includes("eth_chainId");
    const accountsRead = requestedMethods.includes("eth_accounts");

    assert.isTrue(
      accountsRequested || chainRequested || accountsRead,
      `expected app wallet auth flow to query injected wallet methods, got: ${requestedMethods.join(", ")}`,
    );
  });

  it("authenticated user can run replay deposit flow and open deposit modal", async function () {
    if (!page) {
      this.skip();
      return;
    }
    const activePage = page;

    await activePage.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await activePage.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 40_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(activePage);
    if (isBotChallengePage(title, bodyText)) {
      this.skip();
      return;
    }

    await dismissWorkInProgressModal(activePage);
    await waitForRenderableUi(activePage);
    await dismissWorkInProgressModal(activePage);

    const initialWalletState = await readWalletState(activePage);
    assert.exists(
      initialWalletState,
      "expected injected wallet state on window before replay deposit flow",
    );

    const walletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    if (!walletUiHints.hasInjectedAddressLabel) {
      const connectResult = await clickConnectWalletButton(activePage);
      if (connectResult.clicked) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await clickMetaMaskOptionIfVisible(activePage).catch(() => false);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    const finalWalletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    assert.isTrue(
      finalWalletUiHints.hasInjectedAddressLabel,
      `expected authenticated wallet UI before replay deposit flow, candidates=${JSON.stringify(finalWalletUiHints.candidates)}`,
    );

    await saveTestScreenshot(
      activePage,
      "wallet-auth-replay-deposit-before-open-modal",
      "debug",
    );

    const depositButtonResult = await _clickAnyVisibleDepositButton(activePage);
    assert.isTrue(
      depositButtonResult.clicked,
      `expected top Deposit button click to open modal, candidates=${JSON.stringify(depositButtonResult.candidateLabels)}`,
    );

    await _waitForDepositModalVisible(activePage, 20_000);
    await _waitForDepositModalWalletBalance(activePage, 20_000);

    await runReplayDepositModalSteps(activePage);

    await _waitForDepositModalSettled(activePage, 25_000);

    const methodsAfterDeposit =
      (await readWalletState(activePage))?.requestedMethods ?? [];
    const txRequested =
      methodsAfterDeposit.includes("eth_sendTransaction") ||
      methodsAfterDeposit.includes("wallet_sendTransaction");
    assert.isTrue(
      txRequested,
      `expected replay deposit flow to request a transaction, walletMethods=${methodsAfterDeposit.join(", ")}`,
    );
  });

  it("authenticated user can set size and click buy without network errors", async function () {
    if (!page) {
      this.skip();
      return;
    }
    const activePage = page;

    await activePage.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await activePage.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 40_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(activePage);
    if (isBotChallengePage(title, bodyText)) {
      this.skip();
      return;
    }

    await dismissWorkInProgressModal(activePage);
    await waitForRenderableUi(activePage);
    await dismissWorkInProgressModal(activePage);

    const initialWalletState = await readWalletState(activePage);
    assert.exists(
      initialWalletState,
      "expected injected wallet state on window before trade panel interaction",
    );

    const walletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    if (!walletUiHints.hasInjectedAddressLabel) {
      const connectResult = await clickConnectWalletButton(activePage);
      if (connectResult.clicked) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await clickMetaMaskOptionIfVisible(activePage).catch(() => false);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    const finalWalletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    assert.isTrue(
      finalWalletUiHints.hasInjectedAddressLabel,
      `expected authenticated wallet UI before buy interaction, candidates=${JSON.stringify(finalWalletUiHints.candidates)}`,
    );

    await saveTestScreenshot(
      activePage,
      "wallet-auth-before-size-entry",
      "debug",
    );

    const networkObservation = await observeFetchXhrNetworkDuring(
      activePage,
      async () => {
        const sizeSetResult = await setTradingPanelSizeInput(
          activePage,
          "0.00014",
        );
        assert.isTrue(
          sizeSetResult.inputFound,
          "expected to find a visible trading size input",
        );
        assert.isTrue(
          sizeSetResult.buyButtonFound,
          "expected to find a visible Buy button in trading panel",
        );
        assert.include(
          sizeSetResult.valueAfterSet,
          "0.00014",
          `expected trading size input to reflect entered value, got=${JSON.stringify(sizeSetResult)}`,
        );

        await saveTestScreenshot(
          activePage,
          "wallet-auth-after-size-before-buy-click",
          "debug",
        );

        const buyClickResult = await clickTradingPanelBuyButton(activePage);
        assert.isTrue(
          buyClickResult.buyButtonFound,
          "expected to find Buy button before click",
        );
        assert.isTrue(
          buyClickResult.clicked,
          "expected to click Buy button after setting trade size",
        );
      },
      5_000,
    );

    const relevantCalls = networkObservation.calls.filter(
      (call) =>
        call.url.includes("apimonaco.xyz") || call.url.includes("m1.markets"),
    );
    const relevantErrors = networkObservation.errors.filter(
      (call) =>
        call.url.includes("apimonaco.xyz") || call.url.includes("m1.markets"),
    );

    assert.isAtLeast(
      relevantCalls.length,
      1,
      `expected at least one fetch/xhr call after Buy click, observed=${JSON.stringify(networkObservation.calls)}`,
    );
    if (relevantErrors.length > 0) {
      // Surface API error payloads directly in mocha output for debugging order validation failures.
      console.error(
        "[wallet-auth buy test] failing network calls:",
        JSON.stringify(relevantErrors, null, 2),
      );
    }
    assert.deepEqual(
      relevantErrors,
      [],
      `expected no failing fetch/xhr responses after Buy click, calls=${JSON.stringify(relevantCalls)}`,
    );
  });

  it("authenticated user can open screener and switch replay tabs without network errors", async function () {
    if (!page) {
      this.skip();
      return;
    }
    const activePage = page;

    await activePage.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await activePage.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 40_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(activePage);
    if (isBotChallengePage(title, bodyText)) {
      this.skip();
      return;
    }

    await dismissWorkInProgressModal(activePage);
    await waitForRenderableUi(activePage);
    await dismissWorkInProgressModal(activePage);

    const initialWalletState = await readWalletState(activePage);
    assert.exists(
      initialWalletState,
      "expected injected wallet state on window before screener replay flow",
    );

    const walletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    if (!walletUiHints.hasInjectedAddressLabel) {
      const connectResult = await clickConnectWalletButton(activePage);
      if (connectResult.clicked) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await clickMetaMaskOptionIfVisible(activePage).catch(() => false);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    const finalWalletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    assert.isTrue(
      finalWalletUiHints.hasInjectedAddressLabel,
      `expected authenticated wallet UI before screener replay flow, candidates=${JSON.stringify(finalWalletUiHints.candidates)}`,
    );

    await runReplayOpenScreener(activePage);
    await activePage.waitForFunction(
      'window.location.pathname.includes("/screener")',
      { timeout: 20_000 },
    );
    await waitForRenderableUi(activePage);
    await waitForScreenerLiveData(activePage, 30_000);

    const initialScreenerSummary = await getScreenerLiveDataSummary(activePage);
    assert.isAtLeast(
      initialScreenerSummary.uniquePairCount,
      1,
      `expected screener to show trading pairs after opening screener, summary=${JSON.stringify(initialScreenerSummary)}`,
    );
    assert.isAtLeast(
      initialScreenerSummary.percentCount,
      1,
      `expected screener to show live change values after opening screener, summary=${JSON.stringify(initialScreenerSummary)}`,
    );

    const screenerTabs: Array<"COOKING" | "EQUITIES" | "CRYPTO"> = [
      "COOKING",
      "EQUITIES",
      "CRYPTO",
    ];

    for (const tab of screenerTabs) {
      const observation = await observeFetchXhrNetworkDuring(
        activePage,
        async () => {
          await runReplayClickScreenerTab(activePage, tab);
          await waitForScreenerLiveData(activePage, 30_000);
        },
        4_000,
      );

      const relevantCalls = observation.calls.filter(
        (call) =>
          call.url.includes("apimonaco.xyz") || call.url.includes("m1.markets"),
      );
      const relevantErrors = observation.errors.filter(
        (call) =>
          call.url.includes("apimonaco.xyz") || call.url.includes("m1.markets"),
      );

      if (relevantErrors.length > 0) {
        console.error(
          `[wallet-auth screener ${tab}] failing network calls:`,
          JSON.stringify(relevantErrors, null, 2),
        );
      }

      const screenerSummary = await getScreenerLiveDataSummary(activePage);
      assert.isAtLeast(
        screenerSummary.uniquePairCount,
        1,
        `expected screener trading pairs on ${tab} tab, summary=${JSON.stringify(screenerSummary)}`,
      );
      assert.isAtLeast(
        screenerSummary.percentCount,
        1,
        `expected screener live change data on ${tab} tab, summary=${JSON.stringify(screenerSummary)}`,
      );
      assert.deepEqual(
        relevantErrors,
        [],
        `expected no failing Monaco/app fetch/xhr while opening screener ${tab} tab, calls=${JSON.stringify(relevantCalls)}`,
      );
    }
  });

  it("authenticated user can run replay swap usdc/btc and submit without network errors", async function () {
    if (!page) {
      this.skip();
      return;
    }
    const activePage = page;

    await activePage.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await activePage.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 40_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(activePage);
    if (isBotChallengePage(title, bodyText)) {
      this.skip();
      return;
    }

    await dismissWorkInProgressModal(activePage);
    await waitForRenderableUi(activePage);
    await dismissWorkInProgressModal(activePage);

    const initialWalletState = await readWalletState(activePage);
    assert.exists(
      initialWalletState,
      "expected injected wallet state on window before replay swap flow",
    );

    const walletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    if (!walletUiHints.hasInjectedAddressLabel) {
      const connectResult = await clickConnectWalletButton(activePage);
      if (connectResult.clicked) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await clickMetaMaskOptionIfVisible(activePage).catch(() => false);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    const finalWalletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    assert.isTrue(
      finalWalletUiHints.hasInjectedAddressLabel,
      `expected authenticated wallet UI before replay swap flow, candidates=${JSON.stringify(finalWalletUiHints.candidates)}`,
    );

    await runReplayOpenSwap(activePage);
    await activePage.waitForFunction('window.location.pathname.includes("/swap")', {
      timeout: 20_000,
    });
    await waitForRenderableUi(activePage);

    await runReplayPrepareSwapUsdcBtc(activePage, "10");

    const submitObservation = await observeFetchXhrNetworkDuring(
      activePage,
      async () => {
        await runReplaySubmitSwap(activePage);
      },
      5_000,
    );

    const relevantCalls = submitObservation.calls.filter(
      (call) =>
        call.url.includes("apimonaco.xyz") || call.url.includes("m1.markets"),
    );
    const relevantErrors = submitObservation.errors.filter(
      (call) =>
        call.url.includes("apimonaco.xyz") || call.url.includes("m1.markets"),
    );

    if (relevantErrors.length > 0) {
      console.error(
        "[wallet-auth replay swap test] failing network calls:",
        JSON.stringify(relevantErrors, null, 2),
      );
    }

    assert.isAtLeast(
      relevantCalls.length,
      1,
      `expected fetch/xhr calls after replay swap submit click, calls=${JSON.stringify(submitObservation.calls)}`,
    );
    assert.deepEqual(
      relevantErrors,
      [],
      `expected no failing Monaco/app fetch/xhr after replay swap submit, calls=${JSON.stringify(relevantCalls)}`,
    );
  });

  it("authenticated user can place a limit buy order and cancel it from Open Orders", async function () {
    if (!page) {
      this.skip();
      return;
    }
    const activePage = page;

    await activePage.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await activePage.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 40_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(activePage);
    if (isBotChallengePage(title, bodyText)) {
      this.skip();
      return;
    }

    await dismissWorkInProgressModal(activePage);
    await waitForRenderableUi(activePage);
    await dismissWorkInProgressModal(activePage);

    const initialWalletState = await readWalletState(activePage);
    assert.exists(
      initialWalletState,
      "expected injected wallet state on window before limit order flow",
    );

    const walletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    if (!walletUiHints.hasInjectedAddressLabel) {
      const connectResult = await clickConnectWalletButton(activePage);
      if (connectResult.clicked) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await clickMetaMaskOptionIfVisible(activePage).catch(() => false);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    const finalWalletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    assert.isTrue(
      finalWalletUiHints.hasInjectedAddressLabel,
      `expected authenticated wallet UI before limit order flow, candidates=${JSON.stringify(finalWalletUiHints.candidates)}`,
    );

    const currentPrice = await readCurrentTradePrice(activePage);
    assert.isNotNull(
      currentPrice,
      "expected to read current BTC/USDC price from page",
    );
    if (!currentPrice) {
      return;
    }

    const limitPrice = Number((currentPrice * 0.1).toFixed(2));
    const targetNotionalUsdc = 12;
    const limitSize = Number((targetNotionalUsdc / limitPrice).toFixed(5));
    const limitPriceText = limitPrice.toFixed(2);
    const limitSizeText = limitSize.toFixed(5);

    assert.isAbove(
      limitPrice,
      0,
      `expected computed limit price > 0, got ${limitPriceText}`,
    );
    assert.isAbove(
      limitSize,
      0,
      `expected computed limit size > 0, got ${limitSizeText}`,
    );

    const limitTabClicked = await clickTradePanelModeTab(activePage, "Limit");
    assert.isTrue(
      limitTabClicked,
      "expected to click Limit tab in trade panel",
    );
    await waitForTradePanelModeTabSelected(activePage, "Limit", 15_000);
    await saveTestScreenshot(
      activePage,
      "wallet-auth-limit-tab-selected",
      "debug",
    );

    const limitFormResult = await setLimitPanelPriceAndSize(
      activePage,
      limitPriceText,
      limitSizeText,
    );
    assert.isTrue(limitFormResult.panelFound, "expected Limit panel to exist");
    assert.isTrue(
      limitFormResult.priceInputFound,
      `expected Limit price input, got=${JSON.stringify(limitFormResult)}`,
    );
    assert.isTrue(
      limitFormResult.sizeInputFound,
      `expected Limit size input, got=${JSON.stringify(limitFormResult)}`,
    );
    assert.isTrue(
      limitFormResult.buyButtonFound,
      `expected Limit panel Buy submit button, got=${JSON.stringify(limitFormResult)}`,
    );
    assert.include(
      limitFormResult.priceValueAfterSet.replaceAll(",", ""),
      limitPriceText,
      `expected limit price input value to contain ${limitPriceText}, got=${JSON.stringify(limitFormResult)}`,
    );
    assert.include(
      limitFormResult.sizeValueAfterSet.replaceAll(",", ""),
      limitSizeText,
      `expected limit size input value to contain ${limitSizeText}, got=${JSON.stringify(limitFormResult)}`,
    );

    await saveTestScreenshot(
      activePage,
      "wallet-auth-limit-after-inputs-before-submit",
      "debug",
    );

    const createObservation = await observeFetchXhrNetworkDuring(
      activePage,
      async () => {
        const submitResult = await clickLimitPanelBuySubmit(activePage);
        assert.isTrue(
          submitResult.buyButtonFound,
          "expected Limit panel Buy submit button before click",
        );
        assert.isTrue(
          submitResult.clicked,
          "expected to click Limit panel Buy submit button",
        );
      },
      5_000,
    );

    const createRelevantCalls = createObservation.calls.filter(
      (call) =>
        call.url.includes("apimonaco.xyz") || call.url.includes("m1.markets"),
    );
    const createRelevantErrors = createObservation.errors.filter(
      (call) =>
        call.url.includes("apimonaco.xyz") || call.url.includes("m1.markets"),
    );
    if (createRelevantErrors.length > 0) {
      console.error(
        "[wallet-auth limit create test] failing network calls:",
        JSON.stringify(createRelevantErrors, null, 2),
      );
    }
    const orderCreateCall = createRelevantCalls.find(
      (call) => call.url.includes("/api/v1/orders") && call.method === "POST",
    );
    assert.exists(
      orderCreateCall,
      `expected POST /api/v1/orders after Limit Buy submit, calls=${JSON.stringify(createRelevantCalls)}`,
    );
    assert.deepEqual(
      createRelevantErrors,
      [],
      `expected no failing fetch/xhr responses during limit order create, calls=${JSON.stringify(createRelevantCalls)}`,
    );

    const openOrdersTabClicked = await clickAccountBottomTab(
      activePage,
      "Open Orders",
    );
    assert.isTrue(
      openOrdersTabClicked,
      "expected to click Open Orders bottom tab",
    );
    await saveTestScreenshot(
      activePage,
      "wallet-auth-open-orders-tab-clicked",
      "debug",
    );
    await waitForAccountBottomTabSelected(activePage, "Open Orders", 15_000);
    await waitForOpenOrderPriceVisible(activePage, limitPrice, 40_000);

    await saveTestScreenshot(
      activePage,
      "wallet-auth-limit-order-visible-in-open-orders",
      "debug",
    );

    let skippedCancelBecauseOrderGone = false;
    const cancelObservation = await observeFetchXhrNetworkDuring(
      activePage,
      async () => {
        const cancelResult = await cancelOpenOrderByPrice(
          activePage,
          limitPrice,
        );
        if (!cancelResult.cancelButtonFound || !cancelResult.clicked) {
          const orderStillVisible = await isOpenOrderPriceVisibleNow(
            activePage,
            limitPrice,
          );
          if (!orderStillVisible) {
            skippedCancelBecauseOrderGone = true;
            return;
          }

          assert.isTrue(
            cancelResult.cancelButtonFound,
            `expected cancel button in Open Orders row, candidates=${JSON.stringify(cancelResult.debugCandidates)}`,
          );
          assert.isTrue(
            cancelResult.clicked,
            `expected cancel button click in Open Orders row, candidates=${JSON.stringify(cancelResult.debugCandidates)}`,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
        await confirmCancelOrderIfPromptVisible(activePage).catch(() => false);
        await waitForOpenOrderPriceGone(activePage, limitPrice, 40_000);
      },
      5_000,
    );

    const cancelRelevantCalls = cancelObservation.calls.filter(
      (call) =>
        call.url.includes("apimonaco.xyz") || call.url.includes("m1.markets"),
    );
    const cancelRelevantErrors = cancelObservation.errors.filter(
      (call) =>
        call.url.includes("apimonaco.xyz") || call.url.includes("m1.markets"),
    );
    if (cancelRelevantErrors.length > 0) {
      console.error(
        "[wallet-auth limit cancel test] failing network calls:",
        JSON.stringify(cancelRelevantErrors, null, 2),
      );
    }
    if (skippedCancelBecauseOrderGone) {
      return;
    }
    const orderCancelCall = cancelRelevantCalls.find(
      (call) =>
        call.url.includes("/api/v1/orders") &&
        (call.method === "DELETE" || call.method === "POST"),
    );
    assert.exists(
      orderCancelCall,
      `expected order cancel API call after clicking cancel in Open Orders, calls=${JSON.stringify(cancelRelevantCalls)}`,
    );
    assert.deepEqual(
      cancelRelevantErrors,
      [],
      `expected no failing fetch/xhr responses during limit order cancel, calls=${JSON.stringify(cancelRelevantCalls)}`,
    );
  });

  it("authenticated user can switch all bottom panel tabs without Monaco endpoint errors", async function () {
    if (!page) {
      this.skip();
      return;
    }
    const activePage = page;

    await activePage.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await activePage.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 40_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(activePage);
    if (isBotChallengePage(title, bodyText)) {
      this.skip();
      return;
    }

    await dismissWorkInProgressModal(activePage);
    await waitForRenderableUi(activePage);
    await dismissWorkInProgressModal(activePage);

    const initialWalletState = await readWalletState(activePage);
    assert.exists(
      initialWalletState,
      "expected injected wallet state on window before bottom-tab switching flow",
    );

    const walletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    if (!walletUiHints.hasInjectedAddressLabel) {
      const connectResult = await clickConnectWalletButton(activePage);
      if (connectResult.clicked) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await clickMetaMaskOptionIfVisible(activePage).catch(() => false);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    const finalWalletUiHints = await readWalletUiConnectionHints(
      activePage,
      injectedWalletAddress ?? initialWalletState?.address ?? "0x",
    );
    assert.isTrue(
      finalWalletUiHints.hasInjectedAddressLabel,
      `expected authenticated wallet UI before switching bottom tabs, candidates=${JSON.stringify(finalWalletUiHints.candidates)}`,
    );

    const bottomTabs: Array<
      | "Balances"
      | "Positions"
      | "Open Orders"
      | "Order History"
      | "Trade History"
      | "Funding History"
    > = [
      "Balances",
      "Positions",
      "Open Orders",
      "Order History",
      "Trade History",
      "Funding History",
    ];

    await saveTestScreenshot(
      activePage,
      "wallet-auth-before-bottom-tab-switch-sequence",
      "debug",
    );

    const switchObservation = await observeFetchXhrNetworkDuring(
      activePage,
      async () => {
        for (const tabName of bottomTabs) {
          const clicked = await clickAccountBottomTab(activePage, tabName);
          assert.isTrue(clicked, `expected to click bottom tab "${tabName}"`);
          await waitForAccountBottomTabSelected(activePage, tabName, 15_000);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      },
      5_000,
    );

    await saveTestScreenshot(
      activePage,
      "wallet-auth-after-bottom-tab-switch-sequence",
      "debug",
    );

    const monacoCalls = switchObservation.calls.filter((call) =>
      call.url.includes("apimonaco.xyz"),
    );
    const monacoErrors = switchObservation.errors.filter((call) =>
      call.url.includes("apimonaco.xyz"),
    );

    if (monacoErrors.length > 0) {
      console.error(
        "[wallet-auth bottom-tabs test] failing Monaco network calls:",
        JSON.stringify(monacoErrors, null, 2),
      );
    }

    assert.deepEqual(
      monacoErrors,
      [],
      `expected no failing Monaco fetch/xhr responses while switching bottom tabs, monacoCalls=${JSON.stringify(monacoCalls)}`,
    );
  });
});
