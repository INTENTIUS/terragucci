// The HTML report in a real headless browser, opened from file:// with every
// network request sent to a closed port. Driven over the DevTools protocol
// with Node's own WebSocket, so the test needs no browser package: it finds
// Chrome or Chromium on the machine (CHROME_PATH first) and skips when none.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReport } from "../src/report/build";
import { renderHtml } from "../src/report/html";
import { tmp } from "./helpers";
import { fixture200, RUN } from "./report-fixtures";

function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const cache = join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((n) => n.startsWith("chromium_headless_shell-"))) {
      for (const sub of readdirSync(join(cache, d))) {
        for (const bin of ["chrome-headless-shell", "headless_shell"]) candidates.push(join(cache, d, sub, bin));
      }
    }
  }
  return candidates.find((c): c is string => !!c && existsSync(c));
}

const CHROME = findChrome();

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners: ((m: { method: string; params: Record<string, unknown> }) => void)[] = [];
  constructor(private ws: WebSocket, private session?: string) {
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      } else if (m.method && (!this.session || m.sessionId === this.session)) for (const l of this.listeners) l(m);
    });
  }
  withSession(session: string): Cdp {
    return new Cdp(this.ws, session);
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id + (this.session ? 100000 : 0);
    this.ws.send(JSON.stringify({ id, method, params, ...(this.session ? { sessionId: this.session } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }
  on(l: (m: { method: string; params: Record<string, unknown> }) => void): void {
    this.listeners.push(l);
  }
  once(method: string): Promise<void> {
    return new Promise((resolve) => this.on((m) => m.method === method && resolve()));
  }
}

describe.skipIf(!CHROME)("the HTML report in a headless browser", () => {
  let chrome: ChildProcess;
  let page: Cdp;
  let url: string;
  const requests: string[] = [];
  const report = buildReport({ run: RUN, roots: fixture200() });
  const big = report.groups.find((g) => g.units.length === 180)!;

  const evaluate = async <T,>(expression: string): Promise<T> => {
    const r = await page.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const go = async (to: string) => {
    const loaded = page.once("Page.loadEventFired");
    await page.send("Page.navigate", { url: to });
    await loaded;
  };

  beforeAll(async () => {
    const dir = tmp("terragucci-html-");
    writeFileSync(join(dir, "report.html"), renderHtml(report));
    url = pathToFileURL(join(dir, "report.html")).href;
    chrome = spawn(CHROME!, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${tmp("terragucci-chrome-")}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      // The network is off: anything not on this machine goes to a closed port.
      "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>",
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let err = "";
      chrome.stderr!.on("data", (d) => {
        err += String(d);
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) resolve(m[1]);
      });
      chrome.on("exit", () => reject(new Error(`chrome exited: ${err}`)));
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    const browser = new Cdp(ws);
    const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    page = browser.withSession(sessionId);
    page.on((m) => {
      if (m.method === "Network.requestWillBeSent") requests.push(String((m.params.request as { url: string }).url));
    });
    await page.send("Page.enable");
    await page.send("Network.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await go(url);
  }, 120_000); // the whole file took about 11 s on a runner; beside the tofu tests the hook passed 30 s

  afterAll(() => {
    chrome?.kill();
  });

  it("opens from file:// and asks the network for nothing", async () => {
    expect(await evaluate<number>("document.querySelectorAll('.root').length")).toBe(200);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((r) => !r.startsWith("file:") && !r.startsWith("about:") && !r.startsWith("data:"))).toEqual([]);
  });

  it("the first screen shows every destroy, every replacement and every outlier root, none behind a fold", async () => {
    const rows = await evaluate<{ text: string; bottom: number; height: number; hidden: boolean }[]>(`
      [...document.querySelectorAll('#pinned li, #first li.outlier')].map(el => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent, bottom: r.bottom, height: r.height, hidden: !!el.closest('details:not([open])') || el.offsetParent === null };
      })`);
    const viewport = await evaluate<number>("window.innerHeight");
    for (const n of report.named.filter((x) => x.action === "delete" || x.action === "replace")) {
      expect(rows.some((r) => r.text.includes(n.root) && r.text.includes(n.address!)), `${n.root} ${n.address}`).toBe(true);
    }
    const outliers = report.roots.filter((r) => r.why.some((w) => w.startsWith("outlier")));
    expect(outliers.length).toBeGreaterThan(0);
    for (const o of outliers) expect(rows.some((r) => r.text.includes(o.path)), o.path).toBe(true);
    for (const r of rows) {
      expect(r.hidden, r.text).toBe(false);
      expect(r.height).toBeGreaterThan(0);
      expect(r.bottom, r.text).toBeLessThanOrEqual(viewport);
    }
    // The roots themselves are open below, and the identical group is folded.
    for (const n of report.named) expect(await evaluate<boolean>(`document.getElementById(${JSON.stringify(`root-${n.root}`)}).open`), n.root).toBe(true);
    expect(await evaluate<boolean>(`document.getElementById("group-${big.id}").open`)).toBe(false);
  });

  it("filters by group, action and root, and the destroys stay pinned above every filter", async () => {
    const visible = (sel: string) => evaluate<number>(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null).length`);
    const set = (id: string, value: string) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input')); })()`);
    const pinned = await visible("#pinned li");

    await set("f-group", big.id);
    expect(await visible(".root")).toBe(180);
    expect(await visible(".group")).toBe(1);
    expect(await visible("#pinned li")).toBe(pinned);

    await set("f-group", "");
    await set("f-action", "delete");
    expect(await visible(".root")).toBe(2);
    expect(await visible("#pinned li")).toBe(pinned);

    await set("f-action", "");
    await set("f-root", "r19");
    expect(await visible(".root")).toBe(10);
    expect(await evaluate<string>("document.getElementById('shown').textContent")).toBe("10 of 200 roots shown");
    expect(await visible("#pinned li")).toBe(pinned);
    await set("f-root", "");
  });

  it("a link to a root opens it, however folded it was", async () => {
    expect(await evaluate<boolean>(`document.getElementById("root-envs/r000/app").open`)).toBe(false);
    // Followed inside the page, and opened fresh from a link elsewhere.
    await evaluate(`location.hash = "#root-envs/r000/app"`);
    await new Promise((r) => setTimeout(r, 100));
    expect(await evaluate<boolean>(`document.getElementById("root-envs/r000/app").open`)).toBe(true);
    await go("about:blank");
    await go(`${url}#root-envs/r001/app`);
    expect(await evaluate<boolean>(`document.getElementById("root-envs/r001/app").open`)).toBe(true);
  });

  it("follows the reader's light or dark setting", async () => {
    const bg = () => evaluate<string>("getComputedStyle(document.body).backgroundColor");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    const light = await bg();
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    expect(await bg()).not.toBe(light);
  });
});
