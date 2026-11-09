/**
 * The driver app's service worker (public/sw.js), run as it is in a fake
 * worker scope (node:vm): what it answers, and above all what it keeps. The
 * roadmap carries patient health data, which must never land in the phone's
 * cache: every scenario below ends with a check of the whole cache.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

const SOURCE = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
const ORIGIN = "https://opti-taxi.example";
// Fictitious patient data, as a roadmap or an API answer would carry it.
const PATIENT = "Jeanne MARTIN — 12 rue des Lilas, code 4521B";
const META_URL = "/__opti-taxi/offline-meta";

type Handler = (event: unknown) => void;

class FakeCache {
  readonly entries = new Map<string, Response>();
  async addAll(urls: string[]) {
    for (const url of urls) this.entries.set(url, new Response(`<svg>${url}</svg>`, { headers: { "Content-Type": "image/svg+xml" } }));
  }
  async put(url: string, response: Response) {
    this.entries.set(url, response);
  }
  async match(url: string) {
    return this.entries.get(url)?.clone();
  }
}

function setup(network: (request: Request) => Promise<Response>, options: { timeoutNow?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, FakeCache>();
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name)!;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (url: string) => {
      for (const store of stores.values()) {
        const hit = await store.match(url);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const context = vm.createContext({
    self,
    caches,
    fetch: (request: Request | string) => network(typeof request === "string" ? new Request(`${ORIGIN}${request}`) : request),
    Response,
    Request,
    URL,
    Intl,
    Promise,
    JSON,
    String,
    Number,
    Date,
    Error,
    // The navigation timeout fires at once when asked (a network that never answers).
    setTimeout: (fn: () => void, ms: number) => (options.timeoutNow ? setTimeout(fn, 0) : setTimeout(fn, ms)),
    clearTimeout,
  });
  vm.runInContext(SOURCE, context);

  /** Dispatches an event; resolves to the answer given with respondWith, null when the worker left it alone. */
  async function dispatch(type: string, data: Record<string, unknown>): Promise<Response | null> {
    const waits: Promise<unknown>[] = [];
    const answer: { response: Promise<Response> | null } = { response: null };
    handlers.get(type)?.({
      ...data,
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      respondWith: (promise: Promise<Response>) => {
        answer.response = Promise.resolve(promise);
      },
    });
    await Promise.all(waits);
    return answer.response ? await answer.response : null;
  }

  return {
    install: () => dispatch("install", {}),
    activate: () => dispatch("activate", {}),
    message: (data: unknown) => dispatch("message", { data }),
    fetch: (url: string, init: { mode?: RequestMode; method?: string } = {}) => {
      const request = new Request(`${ORIGIN}${url}`, { method: init.method ?? "GET" });
      Object.defineProperty(request, "mode", { value: init.mode ?? "navigate" });
      return dispatch("fetch", { request });
    },
    stores,
    /** Every URL kept in any cache, and the text of everything kept. */
    async cached(): Promise<{ urls: string[]; text: string }> {
      const urls: string[] = [];
      let text = "";
      for (const store of stores.values()) {
        for (const [url, response] of store.entries) {
          urls.push(url);
          text += await response.clone().text();
        }
      }
      return { urls: urls.sort(), text };
    },
  };
}

const roadmap = () => new Response(`<html><body>${PATIENT}</body></html>`, { status: 200, headers: { "Content-Type": "text/html" } });
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

async function expectNoPatientData(sw: ReturnType<typeof setup>) {
  const { urls, text } = await sw.cached();
  expect(urls.every((url) => url === "/icons/icon.svg" || url === META_URL), urls.join(", ")).toBe(true);
  expect(text).not.toContain("Jeanne");
  expect(text).not.toContain("Lilas");
}

describe("service worker of the driver app", () => {
  let sw: ReturnType<typeof setup>;

  beforeEach(async () => {
    sw = setup(async () => roadmap());
    await sw.install();
    await sw.activate();
  });

  it("keeps only the app icon at install", async () => {
    expect((await sw.cached()).urls).toEqual(["/icons/icon.svg"]);
  });

  it("passes the roadmap through from the network and never stores it", async () => {
    const response = await sw.fetch("/chauffeur");
    expect(await response?.text()).toContain(PATIENT);
    await sw.fetch("/chauffeur?date=2026-11-10");
    await expectNoPatientData(sw);
  });

  it("leaves other pages, Next.js data and API calls to the network", async () => {
    expect(await sw.fetch("/planning")).toBeNull();
    // The regulator's driver list shares the /chauffeur prefix of the scope.
    expect(await sw.fetch("/chauffeurs/abc")).toBeNull();
    expect(await sw.fetch("/chauffeur", { mode: "cors" })).toBeNull();
    expect(await sw.fetch("/api/chauffeur/stops/s1/status", { mode: "cors", method: "POST" })).toBeNull();
    // The reachability probe of the roadmap (HEAD) must reach the server.
    expect(await sw.fetch("/icons/icon.svg", { mode: "cors", method: "HEAD" })).toBeNull();
    await expectNoPatientData(sw);
  });

  it("shows the offline page with the regulation's number and the last sync, without network", async () => {
    await sw.message({
      type: "roadmap-synced",
      at: Date.parse("2026-11-09T07:02:00.000Z"),
      regulator: { number: "04 65 71 00 00", href: "tel:0465710000" },
    });
    const offlineSw = setup(offline);
    // Same cache as the online visit: copy what the first worker kept.
    for (const [name, store] of sw.stores) offlineSw.stores.set(name, store);

    const response = await offlineSw.fetch("/chauffeur?date=2026-11-10");
    const html = (await response?.clone().text()) ?? "";
    expect(html).toContain("Pas de réseau");
    expect(html).toContain('href="tel:0465710000"');
    expect(html).toContain("04 65 71 00 00");
    expect(html).toMatch(/Dernière synchronisation de la feuille de route : lundi 9 novembre (à )?08:02/);
    expect(html).toContain('href="/chauffeur?date=2026-11-10">Réessayer');
    expect(response?.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response?.headers.get("cache-control")).toBe("no-store");
    await expectNoPatientData(offlineSw);
  });

  it("keeps only a number and a time from the page's message", async () => {
    await sw.message({
      type: "roadmap-synced",
      at: 1,
      regulator: { number: "04 65 71 00 00", href: "tel:0465710000" },
      patient: PATIENT,
      stops: [{ patient: PATIENT }],
    });
    await sw.message({ type: "roadmap-synced", at: 2, regulator: { number: PATIENT, href: "javascript:alert(1)" } });
    const meta = (await sw.cached()).text;
    expect(meta).toContain('"regulator":null');
    await expectNoPatientData(sw);
  });

  it("escapes what it writes into the offline page", async () => {
    await sw.message({ type: "roadmap-synced", at: 3, regulator: { number: '<img src=x onerror="x">', href: "tel:0465710000" } });
    const offlineSw = setup(offline);
    for (const [name, store] of sw.stores) offlineSw.stores.set(name, store);
    const html = (await (await offlineSw.fetch("/chauffeur"))?.text()) ?? "";
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("shows the offline page when the network does not answer in time, or the proxy cannot reach the app", async () => {
    const stuck = setup(() => new Promise<Response>(() => undefined), { timeoutNow: true });
    expect(await (await stuck.fetch("/chauffeur"))?.text()).toContain("Pas de réseau");
    const proxyDown = setup(async () => new Response("Bad gateway", { status: 502 }));
    expect(await (await proxyDown.fetch("/chauffeur"))?.text()).toContain("Pas de réseau");
    // Without any sync on this phone, it says so.
    expect(await (await proxyDown.fetch("/chauffeur"))?.text()).toContain("Aucune synchronisation enregistrée");
  });

  it("drops the caches of an older version on activation", async () => {
    sw.stores.set("opti-taxi-offline-v0", new FakeCache());
    await sw.activate();
    expect([...sw.stores.keys()]).toEqual(["opti-taxi-offline-v1"]);
  });
});
