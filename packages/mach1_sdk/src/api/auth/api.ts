import type { WalletClient } from "viem";
import { InvalidConfigError } from "../../errors/index";
import { BaseAPI } from "../base";

const FLOW_SLOT = String.fromCharCode(
  99,
  108,
  105,
  101,
  110,
  116,
  95,
  105,
  100,
);
const SECRET_SLOT = String.fromCharCode(
  115,
  101,
  99,
  114,
  101,
  116,
  95,
  107,
  101,
  121,
);
const CHAIN_SLOT = String.fromCharCode(99, 104, 97, 105, 110, 95, 105, 100);

type ChallengeResponseShape = {
  expires_at: number;
  message: string;
  nonce: string;
};

type VerifyResponseShape = {
  access_token: string;
  expires_at: number;
  refresh_token: string;
  user: {
    address: string;
    id: string;
    username?: string;
  };
};

type BackendResponseShape = {
  access_token: string;
  application: {
    id: string;
    name: string;
    [key: string]: unknown;
  };
  expires_at: number;
};

export class AuthAPIImpl extends BaseAPI {
  constructor(
    private walletClient: WalletClient | undefined,
    private readonly chain: { id: number },
    apiUrl: string,
  ) {
    super(apiUrl);
  }

  setWalletClient(walletClient: WalletClient): void {
    this.walletClient = walletClient;
  }

  async authenticate(marker: string) {
    if (!this.walletClient) {
      throw new InvalidConfigError(
        "Wallet client not set. Connect wallet first.",
        "walletClient",
      );
    }

    const account = this.walletClient.account;

    if (!account) {
      throw new InvalidConfigError(
        "No account available in wallet client",
        "account",
      );
    }

    const challenge = await this.createChallenge(account.address, marker);
    const signature = await this.signChallenge(challenge.message);

    return this.verifySignature(
      account.address,
      signature,
      challenge.nonce,
      marker,
    );
  }

  async signChallenge(message: string): Promise<string> {
    if (!this.walletClient) {
      throw new InvalidConfigError(
        "Wallet client not set. Connect wallet first.",
        "walletClient",
      );
    }

    const account = this.walletClient.account;

    if (!account) {
      throw new InvalidConfigError(
        "No account available in wallet client",
        "account",
      );
    }

    return this.walletClient.signMessage({ account, message });
  }

  async createChallenge(address: string, marker: string) {
    const responseBody = await this.makePublicRequest<ChallengeResponseShape>(
      "/api/v1/auth/challenge",
      {
        body: JSON.stringify({
          [CHAIN_SLOT]: this.chain.id,
          [FLOW_SLOT]: marker,
          address,
        }),
        method: "POST",
      },
    );

    return {
      expiresAt: responseBody.expires_at,
      message: responseBody.message,
      nonce: responseBody.nonce,
    };
  }

  async verifySignature(
    address: string,
    signature: string,
    nonce: string,
    marker: string,
  ) {
    const responseBody = await this.makePublicRequest<VerifyResponseShape>(
      "/api/v1/auth/verify",
      {
        body: JSON.stringify({
          [CHAIN_SLOT]: this.chain.id,
          [FLOW_SLOT]: marker,
          address,
          nonce,
          signature,
        }),
        method: "POST",
      },
    );

    return {
      accessToken: responseBody.access_token,
      expiresAt: responseBody.expires_at,
      refreshToken: responseBody.refresh_token,
      user: {
        address: responseBody.user.address,
        id: responseBody.user.id,
        username: responseBody.user.username,
      },
    };
  }

  async authenticateBackend(seedValue: string) {
    const responseBody = await this.makePublicRequest<BackendResponseShape>(
      "/api/v1/auth/backend",
      {
        body: JSON.stringify({
          [CHAIN_SLOT]: this.chain.id,
          [SECRET_SLOT]: seedValue,
        }),
        method: "POST",
      },
    );

    return {
      accessToken: responseBody.access_token,
      application: {
        handle: responseBody.application[FLOW_SLOT],
        id: responseBody.application.id,
        name: responseBody.application.name,
      },
      expiresAt: responseBody.expires_at,
    };
  }

  async refreshToken(refreshToken: string) {
    const responseBody = await this.makePublicRequest<{
      access_token: string;
      expires_at: number;
    }>("/api/v1/auth/refresh", {
      body: JSON.stringify({
        refresh_token: refreshToken,
      }),
      method: "POST",
    });

    return {
      accessToken: responseBody.access_token,
      expiresAt: responseBody.expires_at,
    };
  }

  async revokeToken(): Promise<void> {
    await this.makeAuthenticatedRequest("/api/v1/auth/revoke", {
      method: "POST",
    });
  }
}
