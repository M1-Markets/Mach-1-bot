import type {
  DelegatedAgent,
  DelegatedAgentAction,
  UpsertDelegatedAgentRequest,
} from "mach1_sdk";
import pc from "picocolors";
import prompts from "prompts";
import { isAddress } from "viem";

const AVAILABLE_ACTIONS: DelegatedAgentAction[] = [
  "CREATE_ORDER",
  "CANCEL_ORDER",
  "REPLACE_ORDER",
];

const AVAILABLE_ORDER_TYPES = ["LIMIT", "MARKET"] as const;
const AVAILABLE_TIME_IN_FORCE = ["GTC", "IOC", "FOK"] as const;
const ALL_MARGIN_ACCOUNTS = "__ALL__";

export type DelegatedAgentPairOption = {
  id: string;
  symbol: string;
};

export type DelegatedAgentMarginAccountOption = {
  id: string;
  label: string;
};

type DelegatedAgentPromptResult = {
  name?: string;
  walletAddress?: string;
  expiresAt?: string;
  allowedActions?: DelegatedAgentAction[];
  allowedTradingPairIds?: string[];
  allowedOrderTypes?: Array<(typeof AVAILABLE_ORDER_TYPES)[number]>;
  allowedTimeInForce?: Array<(typeof AVAILABLE_TIME_IN_FORCE)[number]>;
  marginAccountMode?: "all" | "selected";
  allowedMarginAccountIds?: string[];
  maxLeverage?: string;
  maxOrderNotional?: string;
  maxOpenOrders?: string;
};

const normalizeOptionalText = (
  value: string | undefined,
): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const validateOptionalIsoDateTime = (value: string): true | string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  const timestamp = Date.parse(trimmed);
  return Number.isNaN(timestamp)
    ? "Enter ISO datetime like 2026-06-30T12:00:00Z or leave blank"
    : true;
};

const validateOptionalPositiveNumber = (value: string): true | string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0
    ? true
    : "Enter positive number or leave blank";
};

const validateOptionalPositiveInteger = (value: string): true | string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 && String(parsed) === trimmed
    ? true
    : "Enter positive integer or leave blank";
};

const ensurePromptValue = <T>(value: T | undefined, field: string): T => {
  if (value === undefined) {
    throw new Error(`Delegated agent prompt cancelled before ${field}.`);
  }
  return value;
};

const formatMarginAccountChoiceTitle = (
  account: DelegatedAgentMarginAccountOption,
): string => `${account.label} ${pc.gray(`(${account.id})`)}`;

export const formatDelegatedAgentLabel = (
  agent: DelegatedAgent,
  pairLabelsById: Map<string, string>,
): Record<string, unknown> => ({
  id: agent.id,
  name: agent.name ?? "",
  address: agent.agent_address,
  active: agent.is_active,
  expiresAt: agent.expires_at ?? null,
  allowedActions: agent.allowed_actions,
  allowedTradingPairs: agent.allowed_trading_pair_ids.map(
    (pairId) => pairLabelsById.get(pairId) ?? pairId,
  ),
  allowedMarginAccountIds: agent.allowed_margin_account_ids,
  allowedOrderTypes: agent.allowed_order_types ?? [],
  allowedTimeInForce: agent.allowed_time_in_force ?? [],
  maxLeverage: agent.max_leverage ?? null,
  maxOrderNotional: agent.max_order_notional ?? null,
  maxOpenOrders: agent.max_open_orders ?? null,
});

export const promptForDelegatedAgentRequest = async (options: {
  pairOptions: DelegatedAgentPairOption[];
  marginAccounts: DelegatedAgentMarginAccountOption[];
}): Promise<UpsertDelegatedAgentRequest> => {
  if (options.pairOptions.length === 0) {
    throw new Error("No trading pairs available for delegated-agent creation.");
  }

  console.log(pc.cyan("Delegated Agent Setup"));
  console.log(
    pc.gray("Provide existing wallet address. Select permissions and limits."),
  );

  const baseResponse = (await prompts([
    {
      type: "text",
      name: "walletAddress",
      message: pc.yellow("Delegated wallet address"),
      validate: (value: string) =>
        isAddress(value.trim()) ? true : "Enter valid 0x wallet address",
    },
    {
      type: "text",
      name: "name",
      message: pc.yellow("Agent name"),
      initial: "",
    },
    {
      type: "text",
      name: "expiresAt",
      message: pc.yellow("Expiry ISO datetime"),
      initial: "",
      validate: validateOptionalIsoDateTime,
    },
  ])) as DelegatedAgentPromptResult;

  const allowedActions = ensurePromptValue(
    (
      await prompts({
        type: "multiselect",
        name: "allowedActions",
        message: pc.yellow("Allowed actions"),
        choices: AVAILABLE_ACTIONS.map((action) => ({
          title: action,
          value: action,
          selected: true,
        })),
        min: 1,
        instructions: false,
      })
    ).allowedActions as DelegatedAgentAction[] | undefined,
    "allowed actions",
  );

  const allowedTradingPairIds = ensurePromptValue(
    (
      await prompts({
        type: "multiselect",
        name: "allowedTradingPairIds",
        message: pc.yellow("Allowed trading pairs"),
        choices: options.pairOptions.map((pair) => ({
          title: pair.symbol,
          value: pair.id,
        })),
        min: 1,
        instructions: false,
      })
    ).allowedTradingPairIds as string[] | undefined,
    "allowed trading pairs",
  );

  const permissionsResponse = (await prompts([
    {
      type: "multiselect",
      name: "allowedOrderTypes",
      message: pc.yellow("Allowed order types"),
      choices: AVAILABLE_ORDER_TYPES.map((orderType) => ({
        title: orderType,
        value: orderType,
        selected: true,
      })),
      instructions: false,
    },
    {
      type: "multiselect",
      name: "allowedTimeInForce",
      message: pc.yellow("Allowed time in force"),
      choices: AVAILABLE_TIME_IN_FORCE.map((timeInForce) => ({
        title: timeInForce,
        value: timeInForce,
        selected: true,
      })),
      instructions: false,
    },
    {
      type: options.marginAccounts.length > 0 ? "select" : null,
      name: "marginAccountMode",
      message: pc.yellow("Margin account scope"),
      choices: [
        { title: "All margin accounts", value: "all" },
        { title: "Select specific accounts", value: "selected" },
      ],
      initial: 0,
    },
  ])) as DelegatedAgentPromptResult;

  let allowedMarginAccountIds: string[] | undefined;
  if (
    options.marginAccounts.length > 0 &&
    permissionsResponse.marginAccountMode === "selected"
  ) {
    allowedMarginAccountIds = ensurePromptValue(
      (
        await prompts({
          type: "multiselect",
          name: "allowedMarginAccountIds",
          message: pc.yellow("Allowed margin accounts"),
          choices: options.marginAccounts.map((account) => ({
            title: formatMarginAccountChoiceTitle(account),
            value: account.id,
          })),
          min: 1,
          instructions: false,
        })
      ).allowedMarginAccountIds as string[] | undefined,
      "allowed margin accounts",
    );
  }

  const limitsResponse = (await prompts([
    {
      type: "text",
      name: "maxLeverage",
      message: pc.yellow("Max leverage"),
      initial: "",
      validate: validateOptionalPositiveNumber,
    },
    {
      type: "text",
      name: "maxOrderNotional",
      message: pc.yellow("Max order notional"),
      initial: "",
      validate: validateOptionalPositiveNumber,
    },
    {
      type: "text",
      name: "maxOpenOrders",
      message: pc.yellow("Max open orders"),
      initial: "",
      validate: validateOptionalPositiveInteger,
    },
  ])) as DelegatedAgentPromptResult;

  const walletAddress = normalizeOptionalText(baseResponse.walletAddress);
  if (!walletAddress) {
    throw new Error("Delegated wallet address is required.");
  }

  const request: UpsertDelegatedAgentRequest = {
    agentAddress: walletAddress,
    allowedActions,
    allowedTradingPairIds,
  };

  const name = normalizeOptionalText(baseResponse.name);
  if (name) {
    request.name = name;
  }

  const expiresAt = normalizeOptionalText(baseResponse.expiresAt);
  if (expiresAt) {
    request.expiresAt = new Date(expiresAt).toISOString();
  }

  if (permissionsResponse.allowedOrderTypes) {
    request.allowedOrderTypes = permissionsResponse.allowedOrderTypes;
  }

  if (permissionsResponse.allowedTimeInForce) {
    request.allowedTimeInForce = permissionsResponse.allowedTimeInForce;
  }

  if (allowedMarginAccountIds && allowedMarginAccountIds.length > 0) {
    request.allowedMarginAccountIds = allowedMarginAccountIds.filter(
      (accountId) => accountId !== ALL_MARGIN_ACCOUNTS,
    );
  }

  const maxLeverage = normalizeOptionalText(limitsResponse.maxLeverage);
  if (maxLeverage) {
    request.maxLeverage = maxLeverage;
  }

  const maxOrderNotional = normalizeOptionalText(
    limitsResponse.maxOrderNotional,
  );
  if (maxOrderNotional) {
    request.maxOrderNotional = maxOrderNotional;
  }

  const maxOpenOrders = normalizeOptionalText(limitsResponse.maxOpenOrders);
  if (maxOpenOrders) {
    request.maxOpenOrders = Number.parseInt(maxOpenOrders, 10);
  }

  return request;
};

export const promptForDelegatedAgentRemoval = async (
  agents: DelegatedAgent[],
): Promise<DelegatedAgent> => {
  if (agents.length === 0) {
    throw new Error("No delegated agents available to remove.");
  }

  const selectedAgentId = ensurePromptValue(
    (
      await prompts({
        type: "select",
        name: "agentId",
        message: pc.yellow("Select delegated agent to remove"),
        choices: agents.map((agent) => ({
          title: `${agent.name || "Unnamed"} ${pc.gray(`(${agent.agent_address})`)}`,
          description: agent.id,
          value: agent.id,
        })),
        initial: 0,
      })
    ).agentId as string | undefined,
    "agent selection",
  );

  const confirmation = ensurePromptValue(
    (
      await prompts({
        type: "confirm",
        name: "confirmed",
        message: pc.yellow("Revoke selected delegated agent?"),
        initial: false,
      })
    ).confirmed as boolean | undefined,
    "revocation confirmation",
  );

  if (!confirmation) {
    throw new Error("Delegated agent removal cancelled.");
  }

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  if (!selectedAgent) {
    throw new Error(`Delegated agent '${selectedAgentId}' not found.`);
  }

  return selectedAgent;
};
