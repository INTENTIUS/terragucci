#!/usr/bin/env node
// One screenshot of a page in headless Chrome, driven over the DevTools
// protocol so the page can be prepared first, which `chrome --screenshot`
// cannot do. tutorial-capture.sh uses it for Forgejo's job pages.
//
//   node stack/shot.mjs --chrome PATH --url URL --out FILE.png
//        [--width 1280] [--height 860] [--scheme light|dark]
//        [--hide SELECTOR]   hide these elements (a CSS selector list)
//        [--expand TEXT]     open the job step whose summary contains TEXT
//        [--focus REGEX]     scroll the first log line of that step matching
//                            REGEX near the top of the picture
//
// It exits 0 with the picture taken even when a hook finds nothing (the step
// or the line), and says so on stderr; it exits 1 when there is no picture.
// Needs Node 22 or later (the global WebSocket).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const opts = { width: "1280", height: "860", scheme: "light" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith("--") || argv[i + 1] === undefined) die(`bad argument '${argv[i]}'`);
  opts[argv[i].slice(2)] = argv[i + 1];
}
for (const k of ["chrome", "url", "out"]) if (!opts[k]) die(`--${k} is required`);

function die(msg) {
  console.error(`shot: ${msg}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "terragucci-shot-"));
const chrome = spawn(
  opts.chrome,
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--window-size=${opts.width},${opts.height}`, "about:blank"],
  { stdio: "ignore" },
);
const stop = () => { try { chrome.kill(); } catch { /* already gone */ } };
const timer = setTimeout(() => { stop(); die(`timed out on ${opts.url}`); }, 60_000);

try {
  // Chrome writes its port to the profile once it listens.
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) die("Chrome did not start");
  const [port, path] = readFileSync(portFile, "utf-8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("no DevTools connection")); });

  let next = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.no(new Error(`${p.method}: ${msg.error.message}`)); else p.ok(msg.result);
    } else {
      for (const w of waiters.splice(0)) if (w.method === msg.method) w.ok(); else waiters.push(w);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const id = ++next;
    pending.set(id, { ok, no, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const event = (method) => new Promise((ok) => waiters.push({ method, ok }));

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page("Page.enable");
  await page("Emulation.setDeviceMetricsOverride", { width: +opts.width, height: +opts.height, deviceScaleFactor: 1, mobile: false });
  await page("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: opts.scheme }] });
  const loaded = event("Page.loadEventFired");
  await page("Page.navigate", { url: opts.url });
  await loaded;

  const prepare = async ({ hide, expand, focus }) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 15000) => {
      const end = Date.now() + ms;
      let v;
      while (!(v = fn()) && Date.now() < end) await wait(100);
      return v;
    };
    const notes = [];
    // A Forgejo job page renders its jobs and steps after the load event.
    if (document.getElementById("repo-action-view")) {
      await until(() => document.querySelector(".job-step-summary, .action-view-body"));
      await wait(500);
    }
    if (hide) {
      const style = document.createElement("style");
      style.textContent = `${hide} { display: none !important; }`;
      document.head.append(style);
    }
    if (expand) {
      const summary = await until(() => [...document.querySelectorAll(".job-step-summary")].find((s) => s.textContent.includes(expand)));
      if (!summary) return `no step "${expand}" on the page`;
      if (!summary.classList.contains("selected")) summary.click();
      const section = summary.closest(".job-step-section") ?? summary.parentElement;
      const lines = () => section.querySelectorAll(".job-log-line");
      await until(() => lines().length > 0);
      // The view appends a step's lines in batches; wait until they stop.
      for (let n = -1; n !== lines().length; ) { n = lines().length; await wait(700); }
      if (focus) {
        const re = new RegExp(focus);
        const line = [...lines()].find((l) => re.test((l.querySelector(".log-msg") ?? l).textContent));
        if (line) {
          // Keep a few lines of what led up to it above it.
          line.scrollIntoView({ block: "start" });
          window.scrollTo(0, Math.max(0, window.scrollY + line.getBoundingClientRect().top - 120));
        } else {
          notes.push(`no line of "${expand}" matches /${focus}/`);
        }
      }
    }
    await wait(300);
    return notes.join("; ");
  };
  const res = await page("Runtime.evaluate", {
    expression: `(${prepare})(${JSON.stringify({ hide: opts.hide, expand: opts.expand, focus: opts.focus })})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) console.error(`shot: ${opts.url}: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  else if (res.result.value) console.error(`shot: ${opts.url}: ${res.result.value}`);

  const { data } = await page("Page.captureScreenshot", { format: "png" });
  writeFileSync(opts.out, Buffer.from(data, "base64"));
  ws.close();
} catch (e) {
  stop();
  die(`${opts.url}: ${e.message}`);
}
clearTimeout(timer);
stop();
