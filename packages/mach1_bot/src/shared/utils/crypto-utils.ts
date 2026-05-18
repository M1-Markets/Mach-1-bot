import { privateKeyToAccount } from "viem/accounts";

export function normalizePrivateKey(privateKey: string): `0x${string}` {
  return privateKey.startsWith("0x")
    ? (privateKey as `0x${string}`)
    : (`0x${privateKey}` as `0x${string}`);
}

export function getWalletAddressFromPrivateKey(privateKey: string): string {
  return privateKeyToAccount(normalizePrivateKey(privateKey)).address;
}
