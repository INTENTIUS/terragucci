#!/usr/bin/env node
// One screenshot of a page in headless Chrome, driven over the DevTools
// protocol so the page can be prepared first, which `chrome --screenshot`
// cannot do. tutorial-capture.sh, sandbox-github.sh and example-gitlab.sh
// take every picture with it.
//
//   node stack/shot.mjs --chrome PATH --url URL --out FILE.png
//        [--width 1280] [--height 860] [--scheme light|dark]
//        [--dpr 2]           device pixels per CSS pixel: 2 keeps text sharp
//                            at the site's display width
//        [--hide SELECTOR]   hide these elements (a CSS selector list)
//        [--style CSS]       add this CSS to the page first
//        [--click TEXT]      click the first button or summary whose text is
//                            TEXT first, such as a section's "Show more"
//        [--expand TEXT]     open the job step whose summary contains TEXT
//        [--focus REGEX]     a log line of that step must match REGEX; with
//                            no --scroll, it is scrolled near the top
//        [--scroll SELECTOR] the picture is the first element matching
//                            SELECTOR, its own box plus 16px around it, taken
//                            at the page's own top so no sticky header covers
//                            it; --height tall unless --fit
//        [--match REGEX]     with --scroll, the first such element whose text
//                            matches REGEX
//        [--fit 1]           with --scroll, the element's own height
//        [--through REGEX]   with --scroll, the picture runs on to the last
//                            later element matching SELECTOR whose text
//                            matches REGEX
//        [--from REGEX]      with --expand and --scroll, the picture starts at
//                            the first log line of the step matching REGEX,
//                            for a long log
//        [--until REGEX]     with --scroll, the picture ends below the first
//                            log line of the --expand step (or the first
//                            element of --scroll, any line) matching REGEX
//        [--open SPECS]      open these <details> before the picture: SPECS is
//                            one or more SELECTOR::REGEX joined by "||", each
//                            the <details> matching SELECTOR whose <summary>
//                            matches REGEX (an empty REGEX takes the first);
//                            each must exist, and be open and inside the
//                            picture when it is taken
//        [--margin 16]       the CSS pixels of page kept around the element;
//                            a few, when the element is a line in a log
//        [--full-width 1]    with --scroll, keep the page's width instead of
//                            the element's
//        [--cookie NAME=VALUE] send this cookie to the page's site, such as a
//                            signed-in session (example-gitlab.sh shot)
//        [--blank-max 0.5]   refuse a picture more than this share blank
//                            (stack/png.mjs blankShare); 1 allows any
//
// Every hook must find what it names: a missing step, line, element or
// <details> is an error, and no picture is written. It exits 1 then, or when
// the picture is mostly blank (the blank one is kept as FILE.blank.png to look
// at). Needs Node 22 or later (the global WebSocket).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankShare, decode } from "./png.mjs";

const opts = { width: "1280", height: "860", scheme: "light", dpr: "2", "blank-max": "0.5" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith("--") || argv[i + 1] === undefined) die(`bad argument '${argv[i]}'`);
  opts[argv[i].slice(2)] = argv[i + 1];
}
for (const k of ["chrome", "url", "out"]) if (!opts[k]) die(`--${k} is required`);
for (const k of ["through", "until", "from", "fit", "full-width", "match"]) if (opts[k] && !opts.scroll) die(`--${k} needs --scroll`);

function die(msg) {
  console.error(`shot: ${msg}`);
  try { chrome.kill(); } catch { /* not started, or gone */ }
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dpr = +opts.dpr;

const profile = mkdtempSync(join(tmpdir(), "terragucci-shot-"));
const chrome = spawn(
  opts.chrome,
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--window-size=${opts.width},${opts.height}`, "about:blank"],
  { stdio: "ignore" },
);
const stop = () => { try { chrome.kill(); } catch { /* already gone */ } };
const timer = setTimeout(() => { stop(); die(`timed out on ${opts.url}`); }, 90_000);

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
  await page("Emulation.setDeviceMetricsOverride", { width: +opts.width, height: +opts.height, deviceScaleFactor: dpr, mobile: false });
  await page("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: opts.scheme }] });
  if (opts.cookie) {
    const eq = opts.cookie.indexOf("=");
    if (eq < 1) die("--cookie takes NAME=VALUE");
    await page("Network.setCookie", { name: opts.cookie.slice(0, eq), value: opts.cookie.slice(eq + 1), url: opts.url });
  }
  const loaded = event("Page.loadEventFired");
  await page("Page.navigate", { url: opts.url });
  await loaded;

  // Runs in the page. Returns { box } or { error }; notes are warnings.
  const prepare = async ({ hide, expand, focus, scroll, match, through, until: untilRe, from, open, style, click, fullWidth }) => {
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
    // A GitLab page (its body names the page) fills its widgets, notes and
    // job log after the load event, each behind a spinner or a skeleton.
    if (document.body.dataset.page) {
      const busy = () => [...document.querySelectorAll(".gl-spinner, .gl-skeleton-loader, .animation-container")]
        .some((e) => e.offsetParent !== null);
      await wait(1000);
      await until(() => !busy(), 30000);
      if (busy()) notes.push("a GitLab widget was still loading");
      await wait(500);
    }
    // Grafana draws its panels and runs their queries after the load event.
    if (window.grafanaBootData) {
      const loading = () => document.querySelector('[aria-label="Panel loading bar"], .panel-loading, [data-testid="Spinner"]');
      await wait(2000);
      await until(() => !loading(), 30000);
      if (loading()) notes.push("a Grafana panel was still loading");
      await wait(1500);
    }
    if (hide || style) {
      const el = document.createElement("style");
      el.textContent = `${hide ? `${hide} { display: none !important; }` : ""}${style ?? ""}`;
      document.head.append(el);
    }
    if (click) {
      const el = await until(() => [...document.querySelectorAll("button, summary")].find((b) => b.textContent.trim() === click));
      if (!el) return { error: `nothing to click named "${click}"` };
      el.click();
      await wait(700);
    }
    let focusLine;
    if (expand) {
      const summary = await until(() => [...document.querySelectorAll(".job-step-summary")].find((s) => s.textContent.includes(expand)));
      if (!summary) return { error: `no step "${expand}" on the page` };
      if (!summary.classList.contains("selected")) summary.click();
      const section = summary.closest(".job-step-section") ?? summary.parentElement;
      const lines = () => section.querySelectorAll(".job-log-line");
      await until(() => lines().length > 0);
      if (!lines().length) return { error: `step "${expand}" shows no log lines` };
      // The view appends a step's lines in batches; wait until they stop.
      for (let n = -1; n !== lines().length; ) { n = lines().length; await wait(700); }
      const text = (l) => (l.querySelector(".log-msg") ?? l).textContent;
      if (focus) {
        const re = new RegExp(focus);
        focusLine = [...lines()].find((l) => re.test(text(l)));
        if (!focusLine) return { error: `no line of "${expand}" matches /${focus}/` };
        if (!scroll) {
          focusLine.scrollIntoView({ block: "start" });
          window.scrollTo(0, Math.max(0, window.scrollY + focusLine.getBoundingClientRect().top - 120));
        }
      }
      if (from) {
        const re = new RegExp(from);
        const first = [...lines()].find((l) => re.test(text(l)));
        if (!first) return { error: `no line of "${expand}" matches /${from}/` };
        first.dataset.shotFrom = "1";
      }
      if (untilRe) {
        const re = new RegExp(untilRe);
        const start = [...lines()].findIndex((l) => l.dataset.shotFrom);
        const last = [...lines()].slice(Math.max(0, start)).find((l) => re.test(text(l)));
        if (!last) return { error: `no line of "${expand}" matches /${untilRe}/` };
        last.dataset.shotUntil = "1";
      }
    }
    const opened = [];
    for (const spec of open ? open.split("||") : []) {
      const at = spec.indexOf("::");
      const sel = at < 0 ? spec : spec.slice(0, at);
      const re = at < 0 || !spec.slice(at + 2) ? undefined : new RegExp(spec.slice(at + 2));
      const el = await until(() => [...document.querySelectorAll(sel)].find((d) => !re || re.test(d.querySelector("summary")?.textContent ?? d.textContent)));
      if (!el) return { error: `no ${sel}${re ? ` whose summary matches ${re}` : ""} to open` };
      if (el.tagName === "DETAILS") el.open = true; else el.click();
      opened.push({ el, spec });
    }
    if (opened.length) await wait(400);
    let box;
    if (scroll) {
      const re = match ? new RegExp(match) : undefined;
      const all = () => [...document.querySelectorAll(scroll)];
      const el = await until(() => all().find((e) => !re || re.test(e.textContent)));
      if (!el) return { error: `no element ${scroll}${match ? ` matching /${match}/` : ""} on the page` };
      let end = el;
      if (through) {
        const t = new RegExp(through);
        const later = all().slice(all().indexOf(el) + 1);
        end = later.filter((e) => t.test(e.textContent)).at(-1);
        if (!end) return { error: `no ${scroll} after the first matching /${through}/` };
      }
      if (untilRe && !expand) {
        const u = new RegExp(untilRe);
        // The innermost shown element whose text matches: a folded <details>'s body does not count.
        const shown = [...el.querySelectorAll("*")].filter((e) => e.getClientRects().length > 0);
        const line = shown.find((e) => u.test(e.textContent) && ![...e.children].some((c) => c.getClientRects().length > 0 && u.test(c.textContent)));
        if (!line) return { error: `nothing in ${scroll} matches /${untilRe}/` };
        line.dataset.shotUntil = "1";
      }
      // The element's box on the page, read at the page's own top.
      window.scrollTo(0, 0);
      await wait(300);
      const a = el.getBoundingClientRect(), b = end.getBoundingClientRect();
      const stopAt = document.querySelector("[data-shot-until]")?.getBoundingClientRect();
      const startAt = document.querySelector("[data-shot-from]")?.getBoundingClientRect();
      const left = Math.min(a.left, b.left), right = Math.max(a.right, b.right);
      const bottom = stopAt && stopAt.bottom > a.top ? stopAt.bottom : Math.max(a.bottom, b.bottom);
      const top = startAt ? startAt.top : a.top;
      box = { top: top + window.scrollY, height: bottom - top, until: !!stopAt, from: !!startAt, left: fullWidth ? 0 : left, width: fullWidth ? document.documentElement.clientWidth : right - left };
      // Every <details> it opened is open and inside the picture.
      for (const { el: d, spec } of opened) {
        const r = d.getBoundingClientRect();
        if (d.tagName === "DETAILS" && !d.open) return { error: `${spec} did not stay open` };
        if (r.top + window.scrollY < box.top - 1 || r.top > bottom) return { error: `${spec} is open but outside the picture` };
      }
    }
    await wait(300);
    return { notes: notes.join("; "), box, docWidth: document.documentElement.scrollWidth };
  };
  const res = await page("Runtime.evaluate", {
    expression: `(${prepare})(${JSON.stringify({ hide: opts.hide, expand: opts.expand, focus: opts.focus, scroll: opts.scroll, match: opts.match, through: opts.through, until: opts.until, from: opts.from, open: opts.open, style: opts.style, click: opts.click, fullWidth: !!opts["full-width"] })})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) die(`${opts.url}: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  const prepared = res.result?.value ?? {};
  if (prepared.error) die(`${opts.url}: ${prepared.error}`);
  if (prepared.notes) console.error(`shot: ${opts.url}: ${prepared.notes}`);

  // A scrolled shot is a clip of the page around its element, taken beyond
  // the viewport, so the page never scrolls and nothing sticky moves.
  const margin = +(opts.margin ?? 16);
  let clip;
  if (prepared.box) {
    const b = prepared.box;
    const x = Math.max(0, Math.floor(b.left - margin));
    const width = Math.min(Math.max(prepared.docWidth, +opts.width), Math.ceil(b.left + b.width + margin)) - x;
    // A picture that starts or ends at a log line (--from, --until) keeps no
    // margin there: a margin would show half of the line beside it.
    const y = Math.max(0, Math.floor(b.top - (b.from ? 0 : margin)));
    const below = b.until ? 0 : margin;
    clip = { x, y, width, height: opts.fit || opts.through || opts.until ? Math.ceil(b.top + b.height + below) - y : +opts.height, scale: 1 };
  }
  const { data } = await page("Page.captureScreenshot", clip ? { format: "png", clip, captureBeyondViewport: true } : { format: "png" });
  const png = Buffer.from(data, "base64");
  ws.close();
  const blank = blankShare(decode(png), Math.round(20 * dpr), clip ? Math.round(margin * dpr) : 0);
  if (blank > +opts["blank-max"]) {
    writeFileSync(opts.out.replace(/\.png$/, "") + ".blank.png", png);
    die(`${opts.url}: the picture is ${Math.round(blank * 100)}% blank (at most ${Math.round(+opts["blank-max"] * 100)}%); it is kept as ${opts.out.replace(/\.png$/, "")}.blank.png`);
  }
  writeFileSync(opts.out, png);
} catch (e) {
  stop();
  die(`${opts.url}: ${e.message}`);
}
clearTimeout(timer);
stop();
