/**
 * Contract address constants
 */

import { Address, ContractAddresses } from "../types/config";

// Hardcoded contract addresses - users don't need to provide these
export const DEFAULT_CONTRACT_ADDRESSES: ContractAddresses = {
  clob: "0x1234567890123456789012345678901234567890" as Address,
  book: "0x2345678901234567890123456789012345678901" as Address,
  state: "0x3456789012345678901234567890123456789012" as Address,
  vault: "0x4567890123456789012345678901234567890123" as Address,
};

// Pit pass is always active - no user configuration needed
export const MACH1_PIT_PASS = "mach1_access_always_enabled";
