import { describe, expect, it, vi } from "vitest";
import type { SendOutcome } from "./status-protocol";
import { isQueuedStatus, localStatusShown, memoryStorage, StatusQueue, type QueuedStatus } from "./status-queue";

const OK: SendOutcome = { kind: "ok", message: "Enregistré.", serverTime: 1_000, sessionExpiresAt: null };
const OFFLINE: SendOutcome = { kind: "retry", reason: "offline" };

/** A queue on an in-memory storage, a clock that ticks one second per tap and a scripted server. */
function setup(options: { stored?: QueuedStatus[]; answers?: SendOutcome[]; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const storage = options.storage ?? memoryStorage(options.stored);
  const answers = [...(options.answers ?? [])];
  const sent: QueuedStatus[] = [];
  let clock = 1_700_000_000_000;
  const onDelivered = vi.fn();
  const send = vi.fn(async (status: QueuedStatus) => {
    sent.push(status);
    return answers.shift() ?? OK;
  });
  const queue = new StatusQueue({ openStorage: async () => storage, send, now: () => (clock += 1000), onDelivered });
  return { queue, storage, sent, send, onDelivered, answers };
}

describe("StatusQueue", () => {
  it("keeps only the stop, the action and the time of the gesture, before sending anything", async () => {
    const storage = memoryStorage();
    let seenBeforeSend: QueuedStatus[] = [];
    const queue = new StatusQueue({
      openStorage: async () => storage,
      send: async () => {
        seenBeforeSend = storage.values();
        return OK;
      },
      now: () => 1_700_000_123_000,
    });
    await queue.submit("stop_1", "PICKUP");
    expect(seenBeforeSend).toEqual([{ stopId: "stop_1", action: "PICKUP", observedAt: 1_700_000_123_000 }]);
    expect(Object.keys(seenBeforeSend[0] ?? {}).sort()).toEqual(["action", "observedAt", "stopId"]);
    // Sent and acknowledged: nothing left on the phone.
    expect(storage.values()).toEqual([]);
    expect(queue.getSnapshot()).toMatchObject({ pending: 0, byStop: { stop_1: { action: "PICKUP", phase: "sent", serverTime: 1_000 } } });
  });

  it("waits without network, then sends in order with the time of each gesture", async () => {
    const { queue, storage, sent } = setup({ answers: [OFFLINE, OFFLINE] });
    await queue.submit("stop_1", "PICKUP");
    expect(queue.getSnapshot()).toMatchObject({ pending: 1, waitingForNetwork: true, byStop: { stop_1: { phase: "queued" } } });
    // Still offline for the second tap: it is not even tried before the first one.
    await queue.submit("stop_2", "DROPOFF");
    const [first, second] = storage.values();
    expect(sent.map((s) => s.stopId)).toEqual(["stop_1", "stop_1"]);
    expect(first!.observedAt).toBeLessThan(second!.observedAt);

    await queue.flush();
    expect(sent.slice(2)).toEqual([first, second]);
    expect(queue.getSnapshot()).toMatchObject({ pending: 0, waitingForNetwork: false });
    expect(storage.values()).toEqual([]);
  });

  it("survives a reload: statuses saved by an earlier visit are loaded and sent", async () => {
    const stored: QueuedStatus[] = [
      { stopId: "stop_1", action: "PICKUP", observedAt: 10 },
      { stopId: "stop_1", action: "UNDO", observedAt: 20 },
      { stopId: "stop_2", action: "NO_SHOW", observedAt: 30 },
    ];
    const { queue, sent } = setup({ stored, answers: [OFFLINE] });
    await queue.start();
    // The stop shows its latest status.
    expect(queue.getSnapshot()).toMatchObject({
      ready: true,
      pending: 3,
      byStop: { stop_1: { action: "UNDO", phase: "queued" }, stop_2: { action: "NO_SHOW", phase: "queued" } },
    });
    await queue.flush();
    await queue.flush();
    expect(sent).toEqual([stored[0], stored[0], stored[1], stored[2]]);
  });

  it("drops a stored row that is not a status", async () => {
    const storage = memoryStorage([{ stopId: "stop_1", action: "PICKUP", observedAt: 10 }]);
    await storage.add({ stopId: "", action: "PICKUP", observedAt: 1 } as QueuedStatus);
    await storage.add({ stopId: "stop_9", action: "DELETE", observedAt: 1 } as unknown as QueuedStatus);
    const { queue, sent } = setup({ storage });
    await queue.start();
    expect(queue.getSnapshot().pending).toBe(1);
    await queue.flush();
    expect(sent.map((s) => s.stopId)).toEqual(["stop_1"]);
    expect(storage.values()).toEqual([]);
  });

  it("is idempotent: a second tap of a waiting status adds nothing", async () => {
    const { queue, storage } = setup({ answers: [OFFLINE, OFFLINE] });
    await queue.submit("stop_1", "PICKUP");
    await queue.submit("stop_1", "PICKUP");
    expect(storage.values()).toHaveLength(1);
  });

  it("forgets a waiting status undone before it was sent (nothing reaches the server)", async () => {
    const { queue, storage, sent } = setup({ answers: [OFFLINE] });
    await queue.submit("stop_1", "PICKUP");
    await queue.submit("stop_1", "UNDO");
    expect(storage.values()).toEqual([]);
    expect(queue.getSnapshot()).toMatchObject({ pending: 0, byStop: {} });
    await queue.flush();
    expect(sent).toHaveLength(1);
  });

  it("sends an undo of a status the server already has", async () => {
    const { queue, sent } = setup();
    await queue.submit("stop_1", "UNDO");
    expect(sent).toEqual([expect.objectContaining({ stopId: "stop_1", action: "UNDO" })]);
    expect(queue.getSnapshot().byStop.stop_1).toMatchObject({ action: "UNDO", phase: "sent" });
  });

  it("withdraws a waiting status on request, not one being sent", async () => {
    let release: (outcome: SendOutcome) => void = () => undefined;
    const storage = memoryStorage();
    const queue = new StatusQueue({
      openStorage: async () => storage,
      send: () => new Promise<SendOutcome>((resolve) => (release = resolve)),
      now: () => 5,
    });
    const submitted = queue.submit("stop_1", "PICKUP");
    await vi.waitFor(() => expect(queue.getSnapshot().byStop.stop_1?.phase).toBe("sending"));
    expect(await queue.cancelQueued("stop_1")).toBe(false);
    release(OFFLINE);
    await submitted;
    expect(await queue.cancelQueued("stop_1")).toBe(true);
    expect(storage.values()).toEqual([]);
    expect(queue.getSnapshot().byStop).toEqual({});
  });

  it("withdraws a status whose send timed out by sending an undo in its place (the server may have it)", async () => {
    const TIMEOUT: SendOutcome = { kind: "retry", reason: "timeout", maybeReceived: true };
    const { queue, storage, sent } = setup({ answers: [TIMEOUT, OFFLINE] });
    await queue.submit("stop_1", "NO_SHOW");
    expect(queue.getSnapshot().byStop.stop_1).toMatchObject({ action: "NO_SHOW", phase: "queued", uncertain: true });

    // « Retirer ce statut »: the absence is not forgotten silently, an undo replaces it.
    expect(await queue.cancelQueued("stop_1")).toBe(true);
    expect(storage.values()).toEqual([expect.objectContaining({ stopId: "stop_1", action: "UNDO" })]);
    expect(queue.getSnapshot()).toMatchObject({ pending: 1, byStop: { stop_1: { action: "UNDO", phase: "queued" } } });
    await queue.flush();
    expect(sent.map((s) => s.action)).toEqual(["NO_SHOW", "UNDO", "UNDO"]);
    expect(storage.values()).toEqual([]);

    // An undo that may already have reached the server is sent again, never withdrawn.
    const again = setup({ answers: [TIMEOUT] });
    await again.queue.submit("stop_2", "UNDO");
    expect(await again.queue.cancelQueued("stop_2")).toBe(false);
    expect(again.storage.values()).toEqual([expect.objectContaining({ action: "UNDO" })]);
  });

  it("forgets a withdrawn status that never left the phone", async () => {
    const { queue, storage, sent } = setup({ answers: [OFFLINE] });
    await queue.submit("stop_1", "PICKUP");
    expect(queue.getSnapshot().byStop.stop_1?.uncertain).toBeUndefined();
    expect(await queue.cancelQueued("stop_1")).toBe(true);
    expect(storage.values()).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("drops a refused status with its reason, and goes on with the next ones", async () => {
    const { queue, storage, sent } = setup({
      stored: [
        { stopId: "stop_1", action: "PICKUP", observedAt: 10 },
        { stopId: "stop_2", action: "PICKUP", observedAt: 20 },
      ],
      answers: [{ kind: "refused", error: "Course annulée par la régulation\u00a0: statut non modifiable.", serverTime: 5 }],
    });
    await queue.start();
    await queue.flush();
    expect(sent).toHaveLength(2);
    expect(storage.values()).toEqual([]);
    expect(queue.getSnapshot()).toMatchObject({
      pending: 0,
      refusals: [{ stopId: "stop_1", action: "PICKUP", error: "Course annulée par la régulation\u00a0: statut non modifiable." }],
      byStop: { stop_2: { phase: "sent" } },
    });
    expect(queue.getSnapshot().byStop.stop_1).toBeUndefined();
    // A new tap on the stop clears its refusal; « J'ai compris » clears them all.
    await queue.submit("stop_1", "NO_SHOW");
    expect(queue.getSnapshot().refusals).toEqual([]);
  });

  it("tells the page about each refusal (it is stale: refreshed), not about a status that waits", async () => {
    const { queue } = setup({ answers: [OFFLINE, { kind: "refused", error: "Conflit.", serverTime: 5 }] });
    const refused = vi.fn();
    queue.onRefused(refused);
    await queue.submit("stop_1", "PICKUP");
    expect(refused).not.toHaveBeenCalled();
    await queue.flush();
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ stopId: "stop_1", action: "PICKUP", error: "Conflit." }));
  });

  it("pauses on an expired session, keeps everything, and resumes after the sign-in", async () => {
    const { queue, storage, sent } = setup({ answers: [{ kind: "session", reason: "expired" }] });
    await queue.submit("stop_1", "PICKUP");
    await queue.submit("stop_2", "PICKUP");
    expect(queue.getSnapshot()).toMatchObject({ sessionLost: "expired", pending: 2 });
    expect(sent).toHaveLength(1);
    expect(storage.values()).toHaveLength(2);
    await queue.resume();
    expect(sent.map((s) => s.stopId)).toEqual(["stop_1", "stop_1", "stop_2"]);
    expect(queue.getSnapshot()).toMatchObject({ sessionLost: null, pending: 0 });
  });

  it("treats a send that throws as a network failure", async () => {
    const storage = memoryStorage();
    const queue = new StatusQueue({ openStorage: async () => storage, send: async () => Promise.reject(new Error("boom")), now: () => 1 });
    await queue.submit("stop_1", "PICKUP");
    expect(queue.getSnapshot()).toMatchObject({ pending: 1, waitingForNetwork: true });
  });

  it("tells the page to refresh after each delivery, and lets a later render take over the stop", async () => {
    const { queue, onDelivered } = setup();
    await queue.submit("stop_1", "PICKUP");
    expect(onDelivered).toHaveBeenCalledWith(OK);
    // A render from before the status was saved does not show it yet: the local status stays.
    queue.serverRendered(999);
    expect(queue.getSnapshot().byStop.stop_1?.phase).toBe("sent");
    queue.serverRendered(1_000);
    expect(queue.getSnapshot().byStop).toEqual({});
  });

  it("keeps statuses in memory when the phone has no usable storage", async () => {
    const queue = new StatusQueue({
      openStorage: async () => Promise.reject(new Error("no IndexedDB")),
      send: async () => OFFLINE,
      now: () => 1,
    });
    await queue.submit("stop_1", "PICKUP");
    expect(queue.getSnapshot()).toMatchObject({ volatile: true, pending: 1 });
  });

  it("sends a status tapped while another is being sent, in the same run", async () => {
    let release: (outcome: SendOutcome) => void = () => undefined;
    const sent: string[] = [];
    const queue = new StatusQueue({
      openStorage: async () => memoryStorage(),
      send: (status) => {
        sent.push(status.stopId);
        return status.stopId === "stop_1" ? new Promise<SendOutcome>((resolve) => (release = resolve)) : Promise.resolve(OK);
      },
      now: () => 1,
    });
    const first = queue.submit("stop_1", "PICKUP");
    await vi.waitFor(() => expect(sent).toEqual(["stop_1"]));
    const second = queue.submit("stop_2", "PICKUP");
    release(OK);
    await Promise.all([first, second]);
    expect(sent).toEqual(["stop_1", "stop_2"]);
    expect(queue.getSnapshot().pending).toBe(0);
  });
});

describe("localStatusShown", () => {
  const local = (action: QueuedStatus["action"], phase: "queued" | "sending" | "sent") => ({ action, observedAt: 1, phase });

  it("shows a tapped status in place of the buttons of a stop still to do, until the page has it", () => {
    expect(localStatusShown(true, local("PICKUP", "queued"))).toMatchObject({ action: "PICKUP" });
    expect(localStatusShown(true, local("DROPOFF", "sent"))).toMatchObject({ action: "DROPOFF" });
    // An undo already in the page: the stop is open again, its buttons are back.
    expect(localStatusShown(true, local("UNDO", "sent"))).toBeNull();
    expect(localStatusShown(true, undefined)).toBeNull();
  });

  it("shows an undo on a closed stop, and a status not yet sent, never one the page already has", () => {
    expect(localStatusShown(false, local("UNDO", "queued"))).toMatchObject({ action: "UNDO" });
    expect(localStatusShown(false, local("PICKUP", "sent"))).toBeNull();
    expect(localStatusShown(false, local("PICKUP", "queued"))).toMatchObject({ action: "PICKUP" });
  });
});

describe("isQueuedStatus", () => {
  it("accepts exactly a stop id, a known action and a time", () => {
    expect(isQueuedStatus({ stopId: "s", action: "PICKUP", observedAt: 1 })).toBe(true);
    expect(isQueuedStatus({ stopId: "s", action: "PICKUP", observedAt: "1" })).toBe(false);
    expect(isQueuedStatus({ stopId: "x".repeat(65), action: "PICKUP", observedAt: 1 })).toBe(false);
    expect(isQueuedStatus(null)).toBe(false);
  });
});
