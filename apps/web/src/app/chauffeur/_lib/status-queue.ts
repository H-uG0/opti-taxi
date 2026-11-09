/**
 * Queue of the statuses tapped on the roadmap, kept on the phone until the
 * server has them. Every tap goes through it: the status is saved with the
 * time of the gesture before anything is sent, then sent in order, one at a
 * time. Without network (white zones between Sisteron, Gap and Grenoble), with
 * a stuck request (15 s) or an expired session, it simply waits: it is sent
 * again when the network or the app comes back, and survives a reload or the
 * app being killed (IndexedDB, status-queue-idb.ts).
 *
 * What is kept is only { stopId, action, observedAt }: opaque ids and a time,
 * no name, address or note (no health data on the phone).
 *
 * Sending is idempotent end to end: the server ignores a status already in
 * place (a replay after a lost answer), a second tap of the same status while
 * the first waits adds nothing, and « Annuler » on a status still waiting
 * removes it instead of sending both.
 *
 * Free of React and browser APIs (storage and sending are injected), so it is
 * unit-tested; the provider (_components/driver-app-provider.tsx) wires it.
 */
import type { SendOutcome } from "./status-protocol";
import type { StopAction } from "./transitions";

/** A status waiting on the phone: nothing else is stored. */
export type QueuedStatus = { stopId: string; action: StopAction; observedAt: number };

/** A queued status with its storage key (increasing: the order of the taps). */
export type StoredStatus = { key: number; value: QueuedStatus };

export interface QueueStorage {
  /** Every saved status, oldest first. */
  list(): Promise<StoredStatus[]>;
  /** Saves one status (committed when the promise resolves) and returns its key. */
  add(value: QueuedStatus): Promise<number>;
  remove(key: number): Promise<void>;
}

/**
 * Where a stop's latest local status stands: saved and waiting, being sent,
 * or received by the server and not yet in a render of the page.
 */
export type LocalPhase = "queued" | "sending" | "sent";

export type LocalStatus = {
  action: StopAction;
  observedAt: number;
  phase: LocalPhase;
  /** Server clock once saved (phase "sent"): a page rendered later shows it. */
  serverTime?: number;
};

/** A status the server refused for good (removed from the queue): shown until the crew reads it. */
export type Refusal = { id: number; stopId: string; action: StopAction; observedAt: number; error: string };

export type QueueSnapshot = {
  /** The saved statuses are loaded (before that, nothing is shown as waiting). */
  ready: boolean;
  /** Statuses saved on the phone that the server does not have yet. */
  pending: number;
  /** Latest local status of each stop that has one. */
  byStop: Readonly<Record<string, LocalStatus>>;
  refusals: readonly Refusal[];
  /** The server asks for a new sign-in (or a password change): sending is paused, the statuses wait. */
  sessionLost: "expired" | "password" | null;
  /** The last try failed for want of network or server: the statuses wait for the next one. */
  waitingForNetwork: boolean;
  /** No IndexedDB (private browsing…): statuses are kept in memory only, lost if the app is closed. */
  volatile: boolean;
};

export const EMPTY_QUEUE_SNAPSHOT: QueueSnapshot = {
  ready: false,
  pending: 0,
  byStop: {},
  refusals: [],
  sessionLost: null,
  waitingForNetwork: false,
  volatile: false,
};

export type QueueDeps = {
  openStorage: () => Promise<QueueStorage>;
  send: (status: QueuedStatus) => Promise<SendOutcome>;
  now: () => number;
  /** A status reached the server: the page can be refreshed a moment later. */
  onDelivered?: (outcome: Extract<SendOutcome, { kind: "ok" }>) => void;
};

/** In-memory storage: the fallback without IndexedDB, and the tests' storage. */
export function memoryStorage(initial: QueuedStatus[] = []): QueueStorage & { values(): QueuedStatus[] } {
  let next = 1;
  let rows: StoredStatus[] = initial.map((value) => ({ key: next++, value }));
  return {
    list: async () => rows.map((row) => ({ ...row })),
    add: async (value) => {
      const key = next++;
      rows.push({ key, value: { ...value } });
      return key;
    },
    remove: async (key) => {
      rows = rows.filter((row) => row.key !== key);
    },
    values: () => rows.map((row) => row.value),
  };
}

const STOP_ACTION_SET: ReadonlySet<string> = new Set(["PICKUP", "DROPOFF", "NO_SHOW", "UNDO"]);

/** A stored value read back from the phone is used only if it has exactly the expected shape. */
export function isQueuedStatus(value: unknown): value is QueuedStatus {
  if (typeof value !== "object" || value === null) return false;
  const { stopId, action, observedAt } = value as Record<string, unknown>;
  return (
    typeof stopId === "string" &&
    stopId.length > 0 &&
    stopId.length <= 64 &&
    typeof action === "string" &&
    STOP_ACTION_SET.has(action) &&
    typeof observedAt === "number" &&
    Number.isFinite(observedAt)
  );
}

export class StatusQueue {
  private storage: QueueStorage | null = null;
  private starting: Promise<void> | null = null;
  private items: StoredStatus[] = [];
  private byStop: Record<string, LocalStatus> = {};
  private refusals: Refusal[] = [];
  private sessionLost: QueueSnapshot["sessionLost"] = null;
  private waitingForNetwork = false;
  private volatile = false;
  private ready = false;
  private inFlight: number | null = null;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private refusalIds = 0;
  private memoryKeys = -1;
  private listeners = new Set<() => void>();
  private deliveryListeners = new Set<(outcome: Extract<SendOutcome, { kind: "ok" }>) => void>();
  private snapshot: QueueSnapshot = EMPTY_QUEUE_SNAPSHOT;

  constructor(private readonly deps: QueueDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called after each status the server received (deps.onDelivered is called too). */
  onDelivered(listener: (outcome: Extract<SendOutcome, { kind: "ok" }>) => void): () => void {
    this.deliveryListeners.add(listener);
    return () => this.deliveryListeners.delete(listener);
  }

  getSnapshot = (): QueueSnapshot => this.snapshot;

  /** Loads the statuses saved by an earlier visit (once). */
  start(): Promise<void> {
    this.starting ??= this.load();
    return this.starting;
  }

  /** Records a tap: saved at once with the time of the gesture, then sent. */
  async submit(stopId: string, action: StopAction): Promise<void> {
    const observedAt = this.deps.now();
    await this.start();
    this.refusals = this.refusals.filter((refusal) => refusal.stopId !== stopId);
    const last = this.lastItemFor(stopId);

    if (action === "UNDO" && last && last.value.action !== "UNDO" && last.key !== this.inFlight) {
      // « Annuler » on a status the server does not have yet: forget it, nothing to send.
      await this.cancelQueued(stopId);
      return;
    }
    if (last && last.value.action === action) {
      // Same status tapped again while the first one waits: already kept.
      this.emit();
      await this.flush();
      return;
    }

    const value: QueuedStatus = { stopId, action, observedAt };
    let key: number;
    try {
      key = await this.storageOrMemory().add(value);
    } catch {
      // Storage refused (quota, private mode): keep it in memory for this visit.
      key = this.memoryKeys--;
      this.volatile = true;
    }
    this.items.push({ key, value });
    this.byStop = { ...this.byStop, [stopId]: { action, observedAt, phase: "queued" } };
    this.emit();
    await this.flush();
  }

  /**
   * Forgets the stop's latest status still waiting on the phone (« Annuler »
   * before it was sent). False when there is none, or it is being sent: then
   * only a new « Annuler » sent to the server can undo it.
   */
  async cancelQueued(stopId: string): Promise<boolean> {
    await this.start();
    const last = this.lastItemFor(stopId);
    if (!last || last.key === this.inFlight) return false;
    await this.removeItem(last.key);
    this.refreshStop(stopId);
    this.emit();
    return true;
  }

  /** Sends the waiting statuses in order; stops at the first one that must wait. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = this.sendAll().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** The session is valid again (renewed, or signed in again): send what waited. */
  resume(): Promise<void> {
    if (this.sessionLost === null) return this.flush();
    this.sessionLost = null;
    this.emit();
    return this.flush();
  }

  /** The page now shows server data rendered at `serverTime`: statuses saved before it are in it. */
  serverRendered(serverTime: number): void {
    let changed = false;
    const byStop = { ...this.byStop };
    for (const [stopId, local] of Object.entries(byStop)) {
      if (local.phase === "sent" && local.serverTime !== undefined && local.serverTime <= serverTime) {
        delete byStop[stopId];
        changed = true;
      }
    }
    if (!changed) return;
    this.byStop = byStop;
    this.emit();
  }

  dismissRefusals(): void {
    if (this.refusals.length === 0) return;
    this.refusals = [];
    this.emit();
  }

  private async load(): Promise<void> {
    let stored: StoredStatus[] = [];
    try {
      this.storage = await this.deps.openStorage();
      stored = await this.storage.list();
    } catch {
      this.storage = memoryStorage();
      this.volatile = true;
    }
    const valid = stored.filter((row) => isQueuedStatus(row.value)).sort((a, b) => a.key - b.key);
    // Rows that are not a status (another version, tampering) are dropped.
    for (const row of stored) if (!isQueuedStatus(row.value)) await this.storage.remove(row.key).catch(() => undefined);
    this.items = valid;
    for (const stopId of new Set(valid.map((row) => row.value.stopId))) this.refreshStop(stopId);
    this.ready = true;
    this.emit();
  }

  private storageOrMemory(): QueueStorage {
    this.storage ??= memoryStorage();
    return this.storage;
  }

  private lastItemFor(stopId: string): StoredStatus | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item && item.value.stopId === stopId) return item;
    }
    return undefined;
  }

  private async removeItem(key: number): Promise<void> {
    this.items = this.items.filter((item) => item.key !== key);
    if (key > 0) await this.storageOrMemory().remove(key).catch(() => undefined);
  }

  /** The stop's local status from its latest waiting status (or none left). */
  private refreshStop(stopId: string): void {
    const last = this.lastItemFor(stopId);
    const byStop = { ...this.byStop };
    if (last) byStop[stopId] = { action: last.value.action, observedAt: last.value.observedAt, phase: "queued" };
    else delete byStop[stopId];
    this.byStop = byStop;
  }

  private setPhase(item: StoredStatus, local: LocalStatus): void {
    // Only the stop's latest status is shown: an earlier one being sent does not hide a later tap.
    if (this.lastItemFor(item.value.stopId)?.key !== item.key) return;
    this.byStop = { ...this.byStop, [item.value.stopId]: local };
  }

  private async sendAll(): Promise<void> {
    await this.start();
    do {
      this.flushAgain = false;
      while (this.items.length > 0 && this.sessionLost === null) {
        const item = this.items[0]!;
        const { stopId, action, observedAt } = item.value;
        this.inFlight = item.key;
        this.setPhase(item, { action, observedAt, phase: "sending" });
        this.emit();
        let outcome: SendOutcome;
        try {
          outcome = await this.deps.send(item.value);
        } catch {
          outcome = { kind: "retry", reason: "server" };
        }
        this.inFlight = null;

        if (outcome.kind === "retry" || outcome.kind === "session") {
          this.setPhase(item, { action, observedAt, phase: "queued" });
          if (outcome.kind === "session") this.sessionLost = outcome.reason;
          this.waitingForNetwork = outcome.kind === "retry";
          this.emit();
          return;
        }

        this.waitingForNetwork = false;
        const latestForStop = this.lastItemFor(stopId)?.key === item.key;
        await this.removeItem(item.key);
        if (outcome.kind === "ok") {
          if (latestForStop) {
            this.byStop = { ...this.byStop, [stopId]: { action, observedAt, phase: "sent", serverTime: outcome.serverTime } };
          }
          this.deps.onDelivered?.(outcome);
          for (const listener of this.deliveryListeners) listener(outcome);
        } else {
          this.refusals = [...this.refusals, { id: ++this.refusalIds, stopId, action, observedAt, error: outcome.error }];
          if (latestForStop) this.refreshStop(stopId);
        }
        this.emit();
      }
    } while (this.flushAgain && this.sessionLost === null && this.items.length > 0);
  }

  private emit(): void {
    this.snapshot = {
      ready: this.ready,
      pending: this.items.length,
      byStop: this.byStop,
      refusals: this.refusals,
      sessionLost: this.sessionLost,
      waitingForNetwork: this.waitingForNetwork,
      volatile: this.volatile,
    };
    for (const listener of this.listeners) listener();
  }
}

/**
 * What a stop's buttons show given the server's state of the stop and its
 * latest local status: the buttons (null) or the local status in place of
 * them. On a stop still to do, a pickup, dropoff or absence tapped on the
 * phone replaces the buttons until the page shows it; on a closed stop, an
 * undo does (a status just received is already the page's).
 */
export function localStatusShown(stopOpen: boolean, local: LocalStatus | undefined): LocalStatus | null {
  if (!local) return null;
  if (stopOpen) return local.action === "UNDO" ? null : local;
  if (local.action === "UNDO") return local;
  return local.phase === "sent" ? null : local;
}
