/**
 * Whether the server can be reached, going by how the last request went.
 *
 * Nothing here asks the phone whether it has a connection: being on Wi-Fi
 * says nothing about whether this server answers. Every request reports in,
 * and while the server is out of reach and someone is listening, a small one
 * goes out every few seconds to find out when it's back.
 */

const PROBE_MS = 5000;

export class Reach {
  private reachable = true;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;

  /** `probe` is a request cheap enough to repeat. It reports how it went like any other. */
  constructor(private readonly probe: () => Promise<unknown>) {}

  get online(): boolean {
    return this.reachable;
  }

  /** Called when the server goes out of reach and when it comes back, not on every request. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.watch();
    return () => {
      this.listeners.delete(listener);
      this.watch();
    };
  };

  /** A request got an answer. */
  found(): void {
    this.set(true);
  }

  /** A request got none. */
  lost(): void {
    this.set(false);
  }

  /** Asks now instead of at the next try: something suggests the connection is back. */
  check = (): void => {
    if (this.reachable) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.ask();
  };

  private set(reachable: boolean): void {
    const changed = reachable !== this.reachable;
    this.reachable = reachable;
    if (changed) for (const listener of [...this.listeners]) listener();
    this.watch();
  }

  /** Keeps asking for as long as the server is out of reach and someone wants to know. */
  private watch(): void {
    if (this.reachable || this.listeners.size === 0) {
      clearTimeout(this.timer);
      this.timer = undefined;
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.ask();
      }, PROBE_MS);
    }
  }

  private ask(): void {
    // The request itself reports how it went, and that sets up the next try.
    this.probe().catch(() => {});
  }
}
