import { keypairFromHex } from "../../../../node_modules/@0xmonaco/core/dist/crypto/session.js";
import {
  composeSigningString,
  sha256Hex,
  signMessage,
} from "../../../../node_modules/@0xmonaco/core/dist/crypto/session.js";
import type { AuthState as MonacoCoreAuthState } from "./monaco-core-sdk";

export type MonacoSessionAuthState = Pick<
  MonacoCoreAuthState,
  "sessionPrivateKey" | "sessionPublicKey"
>;

export const buildSessionAuthHeaders = (
  authState: MonacoSessionAuthState,
  pathWithQuery: string,
  options?: {
    body?: string;
    method?: string;
    timestampMs?: number;
  },
): Record<string, string> => {
  const timestampMs = options?.timestampMs ?? Date.now();
  const method = options?.method ?? "GET";
  const bodyBytes = new TextEncoder().encode(options?.body ?? "");
  const bodyHash = sha256Hex(bodyBytes);
  const keypair = keypairFromHex(
    authState.sessionPublicKey,
    authState.sessionPrivateKey,
  );
  const signature = signMessage(
    keypair.privateKey,
    composeSigningString(method, pathWithQuery, timestampMs, bodyHash),
  );

  return {
    "X-Monaco-PublicKey": authState.sessionPublicKey,
    "X-Monaco-Signature": signature,
    "X-Monaco-Timestamp": String(timestampMs),
  };
};
