/**
 * Wallet seam.
 *
 * The real wallet will be `BreezWallet implements WalletProvider` on top of
 * breez-sdk-liquid. The SDK ships Rust bindings and won't run in a browser,
 * so web always gets UnavailableWallet.
 *
 * Screens branch on `isAvailable`, never on Platform.OS, so a native user who
 * hasn't finished wallet setup takes the same path as a web guest.
 */

export interface WalletBalance {
  balanceSat: number;
  pendingSat: number;
}

export interface WalletProvider {
  readonly isAvailable: boolean;
  getBalance(): Promise<WalletBalance>;
  getLightningAddress(): Promise<string | null>;
  /** Pays a BOLT11 invoice or Lightning address. Resolves with the preimage. */
  pay(destination: string, amountSat: number): Promise<{ preimage: string }>;
}

export class MockWallet implements WalletProvider {
  readonly isAvailable = true;
  private balanceSat = 184_250;

  async getBalance() {
    await delay(300);
    return { balanceSat: this.balanceSat, pendingSat: 0 };
  }

  async getLightningAddress() {
    await delay(150);
    return 'yash@splitsats.example';
  }

  async pay(_destination: string, amountSat: number) {
    await delay(800);
    if (amountSat > this.balanceSat) throw new Error('Not enough in your balance.');
    this.balanceSat -= amountSat;
    return { preimage: Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('') };
  }
}

export class UnavailableWallet implements WalletProvider {
  readonly isAvailable = false;
  private fail(): never {
    throw new Error('The wallet needs the mobile app.');
  }
  async getBalance(): Promise<WalletBalance> {
    this.fail();
  }
  async getLightningAddress(): Promise<string | null> {
    this.fail();
  }
  async pay(): Promise<{ preimage: string }> {
    this.fail();
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
