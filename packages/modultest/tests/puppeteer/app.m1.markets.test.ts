import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assert } from "chai";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer";

const APP_URL = "https://app.m1.markets";
const ENABLE_ENV = "RUN_PUPPETEER_E2E";
const DEBUG_SCREENSHOT_DIR = "tests/puppeteer-artifacts";

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

async function dismissWorkInProgressModal(page: Page): Promise<void> {
  const clicked = await page
    .evaluate(() => {
      type MaybeButton = { textContent?: string; click?: () => void };
      const pageGlobal = globalThis as {
        document?: {
          querySelectorAll?: (selector: string) => Iterable<unknown>;
        };
      };

      const buttons = Array.from(
        pageGlobal.document?.querySelectorAll?.("button") ?? [],
      ) as MaybeButton[];
      const confirmButton = buttons.find(
        (buttonElement) => buttonElement.textContent?.trim() === "I Understand",
      );

      confirmButton?.click?.();
      return Boolean(confirmButton);
    })
    .catch(() => false);

  if (!clicked) {
    return;
  }

  await page
    .waitForFunction(
      'Array.from(document.querySelectorAll("button")).every((el) => el.textContent?.trim() !== "I Understand")',
      { timeout: 5_000 },
    )
    .catch(() => undefined);
}

async function readPageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pageGlobal = globalThis as {
      document?: { body?: { innerText?: string } };
    };
    return pageGlobal.document?.body?.innerText ?? "";
  });
}

function isExecutionContextDestroyedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Execution context was destroyed")
  );
}

async function readPageTitleAndBodyText(
  page: Page,
): Promise<{ title: string; bodyText: string }> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const [title, bodyText] = await Promise.all([
        page.title(),
        readPageText(page),
      ]);
      return { title, bodyText };
    } catch (error) {
      lastError = error;
      if (!isExecutionContextDestroyedError(error) || attempt === 2) {
        throw error;
      }

      await page
        .waitForFunction(
          'document.readyState === "interactive" || document.readyState === "complete"',
          { timeout: 10_000 },
        )
        .catch(() => undefined);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to read page title/body text");
}

async function waitForTradingHeaderData(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      type MaybeElement = { textContent?: string };
      const pageGlobal = globalThis as {
        document?: {
          body?: { innerText?: string };
          querySelector?: (selector: string) => unknown;
        };
      };

      const pairEl = pageGlobal.document?.querySelector?.(
        '[data-cy="trading-pair-display"]',
      ) as MaybeElement | undefined;
      const pairText = pairEl?.textContent?.trim() ?? "";
      const bodyText = pageGlobal.document?.body?.innerText ?? "";

      const hasPair = pairText === "BTC/USDC";
      const hasVolume = /24H VOLUME\s+\S+/i.test(bodyText);
      const hasPrice = /PRICE\s+\$?[0-9][0-9,]*(?:\.\d+)?/i.test(bodyText);
      const hasChange = /24H CHANGE\s+[+\-−]?\d+(?:\.\d+)?%/i.test(bodyText);
      const hasContract = /CONTRACT\s+0x[0-9a-f]{4}[^\s]*[0-9a-f]{4}/i.test(
        bodyText,
      );
      const headerStillLoading =
        /24H VOLUME\s+Loading\.\.\./i.test(bodyText) ||
        /PRICE\s+Loading\.\.\./i.test(bodyText) ||
        /24H CHANGE\s+Loading\.\.\./i.test(bodyText) ||
        /\bCONTRACT\s+Loading\.\.\./i.test(bodyText);

      return (
        hasPair &&
        hasVolume &&
        hasPrice &&
        hasChange &&
        hasContract &&
        !headerStillLoading
      );
    },
    { timeout: 45_000 },
  );
}

type OrderbookPanelSummary = {
  orderbookTabExists: boolean;
  orderbookTabSelected: boolean;
  ordersTabExists: boolean;
  ordersTabSelected: boolean;
  orderbookPanelExists: boolean;
  ordersPanelExists: boolean;
  asks: number;
  bids: number;
  spreadVisible: boolean;
};

async function getOrderbookPanelSummary(
  page: Page,
): Promise<OrderbookPanelSummary> {
  return page.evaluate(() => {
    type MaybeNode = {
      textContent?: string;
      id?: string;
      getAttribute?: (name: string) => string | null;
      querySelector?: (selector: string) => unknown;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
      getBoundingClientRect?: () => {
        top?: number;
        bottom?: number;
        height?: number;
      };
    };

    const pageGlobal = globalThis as {
      document?: {
        querySelectorAll?: (selector: string) => Iterable<unknown>;
        getElementById?: (id: string) => unknown;
      };
    };

    const allTabs = Array.from(
      pageGlobal.document?.querySelectorAll?.('[role="tab"]') ?? [],
    ) as MaybeNode[];
    const allPanels = Array.from(
      pageGlobal.document?.querySelectorAll?.('[role="tabpanel"]') ?? [],
    ) as MaybeNode[];

    const orderbookTab = allTabs.find(
      (tab) => tab.textContent?.trim() === "Orderbook",
    );
    const ordersTab = allTabs.find(
      (tab) => tab.textContent?.trim() === "Orders",
    );

    const orderbookPanelId =
      orderbookTab?.getAttribute?.("aria-controls") ?? "";
    const ordersPanelId = ordersTab?.getAttribute?.("aria-controls") ?? "";

    const orderbookPanel =
      (orderbookPanelId
        ? (pageGlobal.document?.getElementById?.(
            orderbookPanelId,
          ) as MaybeNode | null)
        : null) ??
      allPanels.find(
        (panel) =>
          panel.getAttribute?.("aria-labelledby") === orderbookTab?.id &&
          panel.getAttribute?.("data-state") === "active",
      ) ??
      null;

    const ordersPanel =
      (ordersPanelId
        ? (pageGlobal.document?.getElementById?.(
            ordersPanelId,
          ) as MaybeNode | null)
        : null) ??
      allPanels.find(
        (panel) => panel.getAttribute?.("aria-labelledby") === ordersTab?.id,
      ) ??
      null;

    const spreadLabel = (
      Array.from(orderbookPanel?.querySelectorAll?.("*") ?? []) as MaybeNode[]
    ).find((el) => el.textContent?.trim() === "Spread");

    const priceButtons = (
      Array.from(
        orderbookPanel?.querySelectorAll?.("button") ?? [],
      ) as MaybeNode[]
    ).filter((button) => /^\d+\.\d{4}$/.test(button.textContent?.trim() ?? ""));
    const spreadTop = spreadLabel?.getBoundingClientRect?.().top ?? Number.NaN;

    const asks = Number.isFinite(spreadTop)
      ? priceButtons.filter(
          (button) =>
            (button.getBoundingClientRect?.().top ?? Number.POSITIVE_INFINITY) <
            spreadTop,
        ).length
      : 0;
    const bids = Number.isFinite(spreadTop)
      ? priceButtons.filter(
          (button) =>
            (button.getBoundingClientRect?.().top ?? Number.NEGATIVE_INFINITY) >
            spreadTop,
        ).length
      : 0;

    return {
      orderbookTabExists: Boolean(orderbookTab),
      orderbookTabSelected:
        orderbookTab?.getAttribute?.("aria-selected") === "true",
      ordersTabExists: Boolean(ordersTab),
      ordersTabSelected: ordersTab?.getAttribute?.("aria-selected") === "true",
      orderbookPanelExists: Boolean(orderbookPanel),
      ordersPanelExists: Boolean(ordersPanel),
      asks,
      bids,
      spreadVisible: Boolean(spreadLabel),
    };
  });
}

async function waitForOrderbookDepth(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      type MaybeNode = {
        textContent?: string;
        getAttribute?: (name: string) => string | null;
        querySelectorAll?: (selector: string) => Iterable<unknown>;
        getBoundingClientRect?: () => {
          top?: number;
          bottom?: number;
          height?: number;
        };
      };

      const pageGlobal = globalThis as {
        document?: {
          querySelectorAll?: (selector: string) => Iterable<unknown>;
          getElementById?: (id: string) => unknown;
        };
      };

      const allTabs = Array.from(
        pageGlobal.document?.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const orderbookTab = allTabs.find(
        (tab) => tab.textContent?.trim() === "Orderbook",
      );
      const panelId = orderbookTab?.getAttribute?.("aria-controls") ?? "";
      const orderbookPanel = panelId
        ? ((pageGlobal.document?.getElementById?.(
            panelId,
          ) as MaybeNode | null) ?? null)
        : null;
      if (!orderbookPanel) {
        return false;
      }

      const spreadLabel = (
        Array.from(orderbookPanel.querySelectorAll?.("*") ?? []) as MaybeNode[]
      ).find((el) => el.textContent?.trim() === "Spread");
      const spreadTop =
        spreadLabel?.getBoundingClientRect?.().top ?? Number.NaN;
      if (!Number.isFinite(spreadTop)) {
        return false;
      }

      const priceButtons = (
        Array.from(
          orderbookPanel.querySelectorAll?.("button") ?? [],
        ) as MaybeNode[]
      ).filter((button) => {
        const priceText = button.textContent?.trim() ?? "";
        return /^\d+\.\d{4}$/.test(priceText);
      });
      const asks = priceButtons.filter(
        (button) =>
          (button.getBoundingClientRect?.().top ?? Number.POSITIVE_INFINITY) <
          spreadTop,
      ).length;
      const bids = priceButtons.filter(
        (button) =>
          (button.getBoundingClientRect?.().top ?? Number.NEGATIVE_INFINITY) >
          spreadTop,
      ).length;
      return asks >= 1 && bids >= 1;
    },
    { timeout: 45_000 },
  );
}

async function clickOrderbookPanelTab(
  page: Page,
  tabText: "Orderbook" | "Orders",
): Promise<void> {
  const targetTabId = await page.evaluate((label) => {
    type MaybeNode = {
      id?: string;
      textContent?: string;
      click?: () => void;
      getAttribute?: (name: string) => string | null;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
    };
    const pageGlobal = globalThis as {
      document?: { querySelectorAll?: (selector: string) => Iterable<unknown> };
    };

    const tablists = Array.from(
      pageGlobal.document?.querySelectorAll?.('[role="tablist"]') ?? [],
    ) as MaybeNode[];

    const orderbookTablist = tablists.find((tablist) => {
      const tabs = Array.from(
        tablist.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
      return labels.includes("Orderbook") && labels.includes("Orders");
    });

    const targetTab = (
      Array.from(
        orderbookTablist?.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[]
    ).find((tab) => tab.textContent?.trim() === label);

    return targetTab?.id ?? null;
  }, tabText);

  assert.isNotNull(
    targetTabId,
    `expected "${tabText}" tab in orderbook panel to exist`,
  );

  if (!targetTabId) {
    return;
  }

  const tabHandle = await page.$(`[id="${targetTabId}"]`);
  assert.exists(
    tabHandle,
    `expected "${tabText}" tab element handle by id "${targetTabId}"`,
  );

  if (tabHandle) {
    try {
      await tabHandle.click({ delay: 20 });
      return;
    } catch {
      // Fall through to synthetic event dispatch if the real click is intercepted.
    }
  }

  const clicked = await page.evaluate((tabId) => {
    type MaybeNode = {
      focus?: () => void;
      dispatchEvent?: (event: Event) => boolean;
    };
    const pageGlobal = globalThis as {
      document?: { getElementById?: (id: string) => unknown };
      PointerEvent?: new (
        type: string,
        init?: Record<string, unknown>,
      ) => Event;
      MouseEvent?: new (type: string, init?: Record<string, unknown>) => Event;
    };

    const targetTab = pageGlobal.document?.getElementById?.(tabId) as
      | MaybeNode
      | undefined;
    if (!targetTab) {
      return false;
    }

    targetTab.focus?.();

    const pointerEventCtor = pageGlobal.PointerEvent;
    const mouseEventCtor = pageGlobal.MouseEvent;
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
    }

    return true;
  }, targetTabId);

  assert.isTrue(clicked, `expected synthetic click on "${tabText}" tab to run`);
}

async function waitForOrderbookTabSelected(
  page: Page,
  tabText: "Orderbook" | "Orders",
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    (label) => {
      type MaybeNode = {
        textContent?: string;
        getAttribute?: (name: string) => string | null;
        querySelectorAll?: (selector: string) => Iterable<unknown>;
      };
      const pageGlobal = globalThis as {
        document?: {
          querySelectorAll?: (selector: string) => Iterable<unknown>;
          getElementById?: (id: string) => unknown;
        };
      };

      const tablists = Array.from(
        pageGlobal.document?.querySelectorAll?.('[role="tablist"]') ?? [],
      ) as MaybeNode[];

      const orderbookTablist = tablists.find((tablist) => {
        const tabs = Array.from(
          tablist.querySelectorAll?.('[role="tab"]') ?? [],
        ) as MaybeNode[];
        const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
        return labels.includes("Orderbook") && labels.includes("Orders");
      });

      if (!orderbookTablist) {
        return false;
      }

      const tabs = Array.from(
        orderbookTablist.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const targetTab = tabs.find((tab) => tab.textContent?.trim() === label);
      const panelId = targetTab?.getAttribute?.("aria-controls") ?? "";
      const panel = panelId
        ? ((pageGlobal.document?.getElementById?.(panelId) as
            | MaybeNode
            | undefined) ?? undefined)
        : undefined;

      const tabSelected =
        targetTab?.getAttribute?.("aria-selected") === "true" ||
        targetTab?.getAttribute?.("data-state") === "active";
      const panelActive =
        panel?.getAttribute?.("data-state") === "active" ||
        panel?.getAttribute?.("hidden") === "false";

      return tabSelected && Boolean(panel) && panelActive;
    },
    { timeout: timeoutMs },
    tabText,
  );
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

type OrdersPanelSummary = {
  ordersTabExists: boolean;
  ordersTabSelected: boolean;
  ordersPanelExists: boolean;
  headerVisible: boolean;
  entryCount: number;
};

type TickerSummary = {
  pairHeaderExists: boolean;
  pairHeaderText: string;
  baseToken: string;
  tickerEntryCount: number;
  tickerEntriesAbovePair: boolean;
  parseableTickerCount: number;
  tickerSymbols: string[];
};

async function getTickerSummary(page: Page): Promise<TickerSummary> {
  return page.evaluate(() => {
    type MaybeNode = {
      textContent?: string;
      getBoundingClientRect?: () => { top?: number; bottom?: number };
    };
    const pageGlobal = globalThis as {
      document?: {
        querySelector?: (selector: string) => unknown;
        querySelectorAll?: (selector: string) => Iterable<unknown>;
      };
    };

    const pairHeader = pageGlobal.document?.querySelector?.(
      '[data-cy="trading-pair-display"]',
    ) as MaybeNode | undefined;
    const pairHeaderText = pairHeader?.textContent?.trim() ?? "";
    const baseToken = pairHeaderText.split("/")[0] ?? "";
    const pairTop =
      pairHeader?.getBoundingClientRect?.().top ?? Number.POSITIVE_INFINITY;

    const allButtons = Array.from(
      pageGlobal.document?.querySelectorAll?.("button") ?? [],
    ) as MaybeNode[];

    const tickerRegex =
      /^([A-Z][A-Z0-9]*?)(?=\d[\d,]*\.\d+\([+\-−]\d+(?:\.\d+)?%\)•$)(\d[\d,]*\.\d+)\(([+\-−]\d+(?:\.\d+)?%)\)•$/;

    const tickerButtons = allButtons
      .map((button) => {
        const rawText = (button.textContent ?? "").replace(/\s+/g, "");
        const match = rawText.match(tickerRegex);
        return {
          rawText,
          match,
          bottom:
            button.getBoundingClientRect?.().bottom ?? Number.POSITIVE_INFINITY,
        };
      })
      .filter((entry) => entry.rawText.length > 0 && entry.match);

    const tickerSymbols = tickerButtons
      .map((entry) => entry.match?.[1] ?? "")
      .filter((symbol) => symbol.length > 0);

    return {
      pairHeaderExists: Boolean(pairHeader),
      pairHeaderText,
      baseToken,
      tickerEntryCount: tickerButtons.length,
      tickerEntriesAbovePair: tickerButtons.every(
        (entry) => entry.bottom < pairTop,
      ),
      parseableTickerCount: tickerButtons.length,
      tickerSymbols,
    };
  });
}

async function waitForTickerData(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      type MaybeNode = {
        textContent?: string;
        getBoundingClientRect?: () => { top?: number; bottom?: number };
      };
      const pageGlobal = globalThis as {
        document?: {
          querySelector?: (selector: string) => unknown;
          querySelectorAll?: (selector: string) => Iterable<unknown>;
        };
      };

      const pairHeader = pageGlobal.document?.querySelector?.(
        '[data-cy="trading-pair-display"]',
      ) as MaybeNode | undefined;
      const pairText = pairHeader?.textContent?.trim() ?? "";
      const baseToken = pairText.split("/")[0] ?? "";
      const pairTop =
        pairHeader?.getBoundingClientRect?.().top ?? Number.POSITIVE_INFINITY;

      const tickerRegex =
        /^([A-Z][A-Z0-9]*?)(?=\d[\d,]*\.\d+\([+\-−]\d+(?:\.\d+)?%\)•$)(\d[\d,]*\.\d+)\(([+\-−]\d+(?:\.\d+)?%)\)•$/;

      const tickerButtons = (
        Array.from(
          pageGlobal.document?.querySelectorAll?.("button") ?? [],
        ) as MaybeNode[]
      )
        .map((button) => ({
          rawText: (button.textContent ?? "").replace(/\s+/g, ""),
          bottom:
            button.getBoundingClientRect?.().bottom ?? Number.POSITIVE_INFINITY,
        }))
        .filter((entry) => tickerRegex.test(entry.rawText));

      const hasBaseTokenTicker = tickerButtons.some((entry) =>
        entry.rawText.startsWith(baseToken),
      );

      return (
        pairText.includes("/") &&
        baseToken.length > 0 &&
        tickerButtons.length >= 1 &&
        tickerButtons.every((entry) => entry.bottom < pairTop) &&
        hasBaseTokenTicker
      );
    },
    { timeout: timeoutMs },
  );
}

async function getFinancialChartFrame(page: Page): Promise<Frame> {
  await page.waitForSelector('iframe[title="Financial Chart"]', {
    visible: true,
    timeout: 30_000,
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const iframeHandle = await page.$('iframe[title="Financial Chart"]');
    const frame = await iframeHandle?.contentFrame();
    if (frame) {
      return frame;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    'Failed to resolve iframe content frame for "Financial Chart"',
  );
}

type ChartSummary = {
  frameUrl: string;
  hasPair: boolean;
  hasVenue: boolean;
  hasOHLCMarkers: boolean;
  numericValueCount: number;
  chartCanvasCount: number;
  chartCanvasLabel: string;
};

async function getChartSummary(frame: Frame): Promise<ChartSummary> {
  return frame.evaluate(() => {
    type MaybeNode = {
      textContent?: string;
      getAttribute?: (name: string) => string | null;
    };
    const pageGlobal = globalThis as {
      document?: {
        body?: { innerText?: string };
        querySelectorAll?: (selector: string) => Iterable<unknown>;
      };
      location?: { href?: string };
    };

    const bodyText = pageGlobal.document?.body?.innerText ?? "";
    const canvases = Array.from(
      pageGlobal.document?.querySelectorAll?.("canvas") ?? [],
    ) as MaybeNode[];
    const chartCanvases = canvases.filter((canvas) =>
      /chart for /i.test(canvas.getAttribute?.("aria-label") ?? ""),
    );

    return {
      frameUrl: pageGlobal.location?.href ?? "",
      hasPair: /BTC\/USDC/i.test(bodyText),
      hasVenue: /Monaco/i.test(bodyText),
      hasOHLCMarkers:
        /\bO\b/.test(bodyText) &&
        /\bH\b/.test(bodyText) &&
        /\bL\b/.test(bodyText) &&
        /\bC\b/.test(bodyText),
      numericValueCount:
        bodyText.match(/\d{1,3}(?:,\d{3})*(?:\.\d+)?/g)?.length ?? 0,
      chartCanvasCount: chartCanvases.length,
      chartCanvasLabel: chartCanvases[0]?.getAttribute?.("aria-label") ?? "",
    };
  });
}

async function waitForChartData(page: Page, timeoutMs: number): Promise<Frame> {
  const frame = await getFinancialChartFrame(page);

  await frame.waitForFunction(
    () => {
      type MaybeNode = {
        textContent?: string;
        getAttribute?: (name: string) => string | null;
      };
      const pageGlobal = globalThis as {
        document?: {
          body?: { innerText?: string };
          querySelectorAll?: (selector: string) => Iterable<unknown>;
        };
      };

      const bodyText = pageGlobal.document?.body?.innerText ?? "";
      const hasPair = /BTC\/USDC/i.test(bodyText);
      const hasVenue = /Monaco/i.test(bodyText);
      const hasOHLCMarkers =
        /\bO\b/.test(bodyText) &&
        /\bH\b/.test(bodyText) &&
        /\bL\b/.test(bodyText) &&
        /\bC\b/.test(bodyText);
      const chartCanvasCount = (
        Array.from(
          pageGlobal.document?.querySelectorAll?.("canvas") ?? [],
        ) as MaybeNode[]
      ).filter((canvas) =>
        /chart for /i.test(canvas.getAttribute?.("aria-label") ?? ""),
      ).length;
      const numericValueCount =
        bodyText.match(/\d{1,3}(?:,\d{3})*(?:\.\d+)?/g)?.length ?? 0;

      return (
        hasPair &&
        hasVenue &&
        hasOHLCMarkers &&
        chartCanvasCount >= 1 &&
        numericValueCount >= 10
      );
    },
    { timeout: timeoutMs },
  );

  return frame;
}

async function getOrdersPanelSummary(page: Page): Promise<OrdersPanelSummary> {
  return page.evaluate(() => {
    type MaybeNode = {
      textContent?: string;
      getAttribute?: (name: string) => string | null;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
    };
    const pageGlobal = globalThis as {
      document?: {
        querySelectorAll?: (selector: string) => Iterable<unknown>;
        getElementById?: (id: string) => unknown;
      };
    };

    const tablists = Array.from(
      pageGlobal.document?.querySelectorAll?.('[role="tablist"]') ?? [],
    ) as MaybeNode[];
    const orderbookTablist = tablists.find((tablist) => {
      const tabs = Array.from(
        tablist.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
      return labels.includes("Orderbook") && labels.includes("Orders");
    });

    const tabs = Array.from(
      orderbookTablist?.querySelectorAll?.('[role="tab"]') ?? [],
    ) as MaybeNode[];
    const ordersTab = tabs.find((tab) => tab.textContent?.trim() === "Orders");
    const panelId = ordersTab?.getAttribute?.("aria-controls") ?? "";
    const panel = panelId
      ? ((pageGlobal.document?.getElementById?.(panelId) as
          | MaybeNode
          | undefined) ?? undefined)
      : undefined;

    const panelTexts = Array.from(
      panel?.querySelectorAll?.("*") ?? [],
    ) as MaybeNode[];
    const timeCells = panelTexts.filter((el) =>
      /^\d{2}:\d{2}:\d{2}$/.test(el.textContent?.trim() ?? ""),
    );
    const headerVisible =
      /price/i.test(panel?.textContent ?? "") &&
      /size/i.test(panel?.textContent ?? "") &&
      /time/i.test(panel?.textContent ?? "");

    return {
      ordersTabExists: Boolean(ordersTab),
      ordersTabSelected:
        ordersTab?.getAttribute?.("aria-selected") === "true" ||
        ordersTab?.getAttribute?.("data-state") === "active",
      ordersPanelExists: Boolean(panel),
      headerVisible,
      entryCount: timeCells.length,
    };
  });
}

async function waitForOrdersPanelEntries(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    () => {
      type MaybeNode = {
        textContent?: string;
        getAttribute?: (name: string) => string | null;
        querySelectorAll?: (selector: string) => Iterable<unknown>;
      };
      const pageGlobal = globalThis as {
        document?: {
          querySelectorAll?: (selector: string) => Iterable<unknown>;
          getElementById?: (id: string) => unknown;
        };
      };

      const tablists = Array.from(
        pageGlobal.document?.querySelectorAll?.('[role="tablist"]') ?? [],
      ) as MaybeNode[];
      const orderbookTablist = tablists.find((tablist) => {
        const tabs = Array.from(
          tablist.querySelectorAll?.('[role="tab"]') ?? [],
        ) as MaybeNode[];
        const labels = tabs.map((tab) => tab.textContent?.trim() ?? "");
        return labels.includes("Orderbook") && labels.includes("Orders");
      });

      const tabs = Array.from(
        orderbookTablist?.querySelectorAll?.('[role="tab"]') ?? [],
      ) as MaybeNode[];
      const ordersTab = tabs.find(
        (tab) => tab.textContent?.trim() === "Orders",
      );
      const panelId = ordersTab?.getAttribute?.("aria-controls") ?? "";
      const panel = panelId
        ? ((pageGlobal.document?.getElementById?.(panelId) as
            | MaybeNode
            | undefined) ?? undefined)
        : undefined;

      const tabSelected =
        ordersTab?.getAttribute?.("aria-selected") === "true" ||
        ordersTab?.getAttribute?.("data-state") === "active";
      const panelActive =
        panel?.getAttribute?.("data-state") === "active" ||
        panel?.getAttribute?.("hidden") === "false";

      const entries = (
        Array.from(panel?.querySelectorAll?.("*") ?? []) as MaybeNode[]
      ).filter((el) =>
        /^\d{2}:\d{2}:\d{2}$/.test(el.textContent?.trim() ?? ""),
      ).length;

      return Boolean(tabSelected && panel && panelActive && entries >= 1);
    },
    { timeout: timeoutMs },
  );
}

describe("puppeteer | app.m1.markets", function () {
  this.timeout(90_000);

  let browser: Browser | undefined;
  let page: Page | undefined;

  before(async function () {
    await resetDebugScreenshotDir();

    if (process.env[ENABLE_ENV] !== "1") {
      this.skip();
    }

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
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
      "puppeteer-test";
    const state = this.currentTest?.state;
    await saveTestScreenshot(page, testTitle, state);
  });

  it("loads the app and resolves to a localized route", async function () {
    if (!page) {
      this.skip();
    }

    const response = await page.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    assert.exists(response, "expected navigation response for app.m1.markets");

    await page.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 20_000 },
    );

    const [title, pageContent] = await Promise.all([
      page.title(),
      page.evaluate(() => {
        const pageGlobal = globalThis as {
          document?: { body?: { innerText?: string; innerHTML?: string } };
        };
        return {
          bodyText: pageGlobal.document?.body?.innerText ?? "",
          bodyHtmlLength: pageGlobal.document?.body?.innerHTML?.length ?? 0,
        };
      }),
    ]);
    const { bodyText, bodyHtmlLength } = pageContent;

    if (isBotChallengePage(title, bodyText)) {
      this.skip();
    }

    await dismissWorkInProgressModal(page);

    const finalUrl = page.url();

    assert.match(
      finalUrl,
      /^https:\/\/app\.m1\.markets\/en(?:\/|$)/,
      `expected localized /en route, got ${finalUrl}`,
    );
    assert.isNotEmpty(title, "page title should not be empty");
    assert.match(title, /mach1/i, `unexpected title: ${title}`);
    assert.isAbove(
      bodyHtmlLength,
      0,
      "page body HTML should not be empty after navigation",
    );
  });

  it("shows BTC/USDC trading pair header and market stats values", async function () {
    if (!page) {
      this.skip();
    }

    await page.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 20_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(page);

    if (isBotChallengePage(title, bodyText)) {
      this.skip();
    }

    await dismissWorkInProgressModal(page);

    const pairHeader = await page.waitForSelector(
      '[data-cy="trading-pair-display"]',
      {
        visible: true,
        timeout: 30_000,
      },
    );
    assert.exists(
      pairHeader,
      'expected trading pair header "[data-cy=trading-pair-display]"',
    );
    if (!pairHeader) {
      return;
    }

    const pairText = await pairHeader.evaluate(
      (el) => el.textContent?.trim() ?? "",
    );

    if (pairText !== "BTC/USDC") {
      await page.waitForFunction(
        () => {
          type MaybeElement = { textContent?: string };
          const pageGlobal = globalThis as {
            document?: { querySelector?: (selector: string) => unknown };
          };
          const el = pageGlobal.document?.querySelector?.(
            '[data-cy="trading-pair-display"]',
          ) as MaybeElement | undefined;
          return el?.textContent?.trim() === "BTC/USDC";
        },
        { timeout: 30_000 },
      );
    }

    const settledPairText = await pairHeader.evaluate(
      (el) => el.textContent?.trim() ?? "",
    );

    assert.strictEqual(
      settledPairText,
      "BTC/USDC",
      `expected default trading pair header to be BTC/USDC, got "${settledPairText}"`,
    );

    await waitForTradingHeaderData(page);

    const marketHeaderText = await readPageText(page);

    assert.match(
      marketHeaderText,
      /24H VOLUME\s+\S+/i,
      "expected 24H VOLUME to have a visible value",
    );
    assert.match(
      marketHeaderText,
      /PRICE\s+\$?[0-9][0-9,]*(?:\.\d+)?/i,
      "expected PRICE to have a visible numeric value",
    );
    assert.match(
      marketHeaderText,
      /24H CHANGE\s+[+\-−]?\d+(?:\.\d+)?%/i,
      "expected 24H CHANGE to have a visible percentage value",
    );
    assert.match(
      marketHeaderText,
      /CONTRACT\s+0x[0-9a-f]{4}[^\s]*[0-9a-f]{4}/i,
      "expected CONTRACT to show a visible contract value",
    );
  });

  it("shows ticker data above the trading pair header and includes the base token", async function () {
    if (!page) {
      this.skip();
    }

    await page.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 20_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(page);

    if (isBotChallengePage(title, bodyText)) {
      this.skip();
    }

    await dismissWorkInProgressModal(page);
    await waitForTradingHeaderData(page);
    await waitForTickerData(page, 30_000);

    const tickerSummary = await getTickerSummary(page);

    assert.isTrue(
      tickerSummary.pairHeaderExists,
      'expected trading pair header "[data-cy=trading-pair-display]" to exist',
    );
    assert.match(
      tickerSummary.pairHeaderText,
      /^[A-Z0-9]+\/[A-Z0-9]+$/,
      `expected trading pair header text like BTC/USDC, got "${tickerSummary.pairHeaderText}"`,
    );
    assert.isNotEmpty(
      tickerSummary.baseToken,
      "expected non-empty base token from trading pair header",
    );
    assert.isAtLeast(
      tickerSummary.tickerEntryCount,
      1,
      "expected at least one ticker entry above the trading pair header",
    );
    assert.isTrue(
      tickerSummary.tickerEntriesAbovePair,
      "expected ticker entries to be positioned above the trading pair header",
    );
    assert.strictEqual(
      tickerSummary.parseableTickerCount,
      tickerSummary.tickerEntryCount,
      "expected ticker entries to have parseable symbol/price/change data",
    );
    assert.include(
      tickerSummary.tickerSymbols,
      tickerSummary.baseToken,
      `expected ticker row to include base token "${tickerSummary.baseToken}"`,
    );
  });

  it("shows chart data in the financial chart iframe", async function () {
    if (!page) {
      this.skip();
    }

    await page.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 20_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(page);

    if (isBotChallengePage(title, bodyText)) {
      this.skip();
    }

    await dismissWorkInProgressModal(page);
    await waitForTradingHeaderData(page);

    const chartFrame = await waitForChartData(page, 45_000);
    const chartSummary = await getChartSummary(chartFrame);

    assert.match(
      chartSummary.frameUrl,
      /^blob:https:\/\/app\.m1\.markets\//,
      `expected chart iframe blob URL from app.m1.markets, got ${chartSummary.frameUrl}`,
    );
    assert.isTrue(
      chartSummary.hasPair,
      "expected chart to show BTC/USDC symbol",
    );
    assert.isTrue(chartSummary.hasVenue, "expected chart to show Monaco venue");
    assert.isTrue(
      chartSummary.hasOHLCMarkers,
      "expected chart to show O/H/L/C markers",
    );
    assert.isAtLeast(
      chartSummary.chartCanvasCount,
      1,
      "expected at least one chart canvas in the chart iframe",
    );
    assert.match(
      chartSummary.chartCanvasLabel,
      /chart for btc\/usdc/i,
      `expected chart canvas aria-label to reference BTC/USDC, got "${chartSummary.chartCanvasLabel}"`,
    );
    assert.isAtLeast(
      chartSummary.numericValueCount,
      10,
      `expected chart iframe text to include numeric chart values, got ${chartSummary.numericValueCount}`,
    );
  });

  it("shows orderbook depth (at least 1 ask / 1 bid) on the current Orderbook tab", async function () {
    if (!page) {
      this.skip();
    }

    await page.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 20_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(page);

    if (isBotChallengePage(title, bodyText)) {
      this.skip();
    }

    await dismissWorkInProgressModal(page);
    await waitForTradingHeaderData(page);
    await waitForOrderbookDepth(page);

    const orderbookSummary = await getOrderbookPanelSummary(page);

    assert.isTrue(
      orderbookSummary.orderbookTabExists,
      "expected Orderbook tab to exist",
    );
    assert.isTrue(
      orderbookSummary.orderbookTabSelected,
      "expected Orderbook tab to be selected by default",
    );
    assert.isTrue(
      orderbookSummary.ordersTabExists,
      "expected Orders tab to exist",
    );
    assert.isTrue(
      orderbookSummary.orderbookPanelExists,
      "expected Orderbook tabpanel to exist",
    );
    assert.isTrue(
      orderbookSummary.spreadVisible,
      "expected Spread divider in orderbook",
    );
    assert.strictEqual(
      orderbookSummary.asks >= 1,
      true,
      `expected at least 1 ask row in orderbook, got ${orderbookSummary.asks}`,
    );
    assert.strictEqual(
      orderbookSummary.bids >= 1,
      true,
      `expected at least 1 bid row in orderbook, got ${orderbookSummary.bids}`,
    );
  });

  it("opens the Orders tab and shows at least one entry", async function () {
    if (!page) {
      this.skip();
    }

    await page.goto(APP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForFunction(
      'window.location.pathname === "/en" || window.location.pathname.startsWith("/en/")',
      { timeout: 20_000 },
    );

    const { title, bodyText } = await readPageTitleAndBodyText(page);

    if (isBotChallengePage(title, bodyText)) {
      this.skip();
    }

    await dismissWorkInProgressModal(page);
    await waitForTradingHeaderData(page);
    await waitForOrderbookDepth(page);

    try {
      await clickOrderbookPanelTab(page, "Orders");
      await waitForOrderbookTabSelected(page, "Orders", 15_000);
      await waitForOrdersPanelEntries(page, 10_000);
    } catch (error) {
      await clickOrderbookPanelTab(page, "Orders").catch(() => undefined);
      try {
        await waitForOrderbookTabSelected(page, "Orders", 15_000);
        await waitForOrdersPanelEntries(page, 10_000);
      } catch (retryError) {
        const errorToThrow = retryError instanceof Error ? retryError : error;
        const summary = await getOrdersPanelSummary(page).catch(
          () => undefined,
        );
        const extra = [
          summary
            ? `summary: ${JSON.stringify(summary)}`
            : "summary: unavailable",
        ].join(" | ");
        if (errorToThrow instanceof Error) {
          errorToThrow.message = `${errorToThrow.message} (${extra})`;
        }
        throw errorToThrow;
      }
    }

    const ordersSummary = await getOrdersPanelSummary(page);
    assert.isTrue(
      ordersSummary.ordersTabExists,
      "expected Orders tab to exist",
    );
    assert.isTrue(
      ordersSummary.ordersTabSelected,
      "expected Orders tab to be selected",
    );
    assert.isTrue(
      ordersSummary.ordersPanelExists,
      "expected Orders tabpanel to exist",
    );
    assert.isTrue(
      ordersSummary.headerVisible,
      "expected Orders headers (Price/Size/Time)",
    );
    assert.isAtLeast(
      ordersSummary.entryCount,
      1,
      `expected at least one Orders entry, got ${ordersSummary.entryCount}`,
    );
  });
});
