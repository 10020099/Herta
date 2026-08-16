/**
 * macOS attachment probe (ADR 0038, 2026-08-15). Runs against the PACKAGED
 * .app on the mac-build runner, right after mac-first-look.mjs, while the app
 * is still up on its CDP port.
 *
 * What it proves that nothing else does: PDF / Word extraction executing on
 * darwin, inside the packaged app — i.e. the lazily-imported pdfjs chunk
 * (`out/main/pdf-*.js`) loading from INSIDE app.asar under Electron's main
 * process, with the DOMMatrix/Path2D stubs and no @napi-rs/canvas anywhere.
 * Every earlier check ran on Windows (dev-mode out/, or the raw chunks under
 * ELECTRON_RUN_AS_NODE), which is the same bundle but not the same container.
 *
 * Fixtures are generated here from the app-server test helpers (built by
 * `pnpm build` earlier in the job), so the run needs no files and no network.
 * No DeepSeek key is involved: attach is an idle-only record write, not a
 * turn, so a keyless session is enough.
 *
 *   node mac-attach-probe.mjs <outDir> [port]
 *
 * Writes attach-probe.json + attach-probe.png, prints a PASS/FAIL line, and
 * exits non-zero on FAIL so the step log shows it — the step itself stays
 * continue-on-error, like the first look.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OUT = process.argv[2];
const PORT = Number(process.argv[3] ?? 9222);
if (!OUT) throw new Error("usage: mac-attach-probe.mjs <outDir> [port]");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures, from the app-server test helpers ----
const fixturesModule = resolve(
  process.cwd(),
  "packages/app-server/dist/testing/document-fixtures.js",
);
const { makePdf, makeDocx, docxParagraphs, makeOleBytes } = await import(
  pathToFileURL(fixturesModule).href
);
const FIX = join(OUT, "attach-fixtures");
mkdirSync(FIX, { recursive: true });
const files = {
  pdf: join(FIX, "report.pdf"),
  docx: join(FIX, "spec.docx"),
  scan: join(FIX, "scan.pdf"),
  locked: join(FIX, "locked.pdf"),
  doc: join(FIX, "legacy.doc"),
};
writeFileSync(
  files.pdf,
  makePdf([["Findings on darwin", "Second line"], ["Page two"]]),
);
writeFileSync(
  files.docx,
  makeDocx(docxParagraphs(["一、背景", "macOS 上的 Word 提取。", "二、验收"])),
);
writeFileSync(files.scan, makePdf([[], []]));
writeFileSync(files.locked, makePdf([["secret"]], { encrypt: true }));
writeFileSync(files.doc, makeOleBytes());

// ---- CDP ----
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.next = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(e));
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `eval: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description ?? "").slice(0, 400)}`,
      );
    }
    return r.result?.value;
  }
}

async function findTarget() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await res.json()).find(
        (t) => t.type === "page" && !t.url.startsWith("devtools://"),
      );
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* app still starting */
    }
    await sleep(2000);
  }
  throw new Error(`no CDP page target on :${PORT}`);
}

const report = { platform: "darwin-runner", steps: [] };
const note = (s) => {
  report.steps.push(s);
  console.log(`  ${s}`);
};
let failed = false;

try {
  const cdp = new Cdp(await findTarget());
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });

  // A session through the real UI: connect if the pill is showing, otherwise
  // new-session then connect. The seeded opening streams without a key.
  const hasConnect = await cdp.eval(
    `document.querySelector('.connect-station') !== null`,
  );
  if (!hasConnect) {
    await cdp.eval(
      `(() => { const b = document.querySelectorAll('.sidebar-header-icon')[2]; if (b) b.click(); return b !== undefined; })()`,
    );
    await sleep(1800);
  }
  const clicked = await cdp.eval(
    `(() => { const b = document.querySelector('.connect-station'); if (b) { b.click(); return true; } return false; })()`,
  );
  note(`connect clicked: ${clicked}`);
  if (!clicked) throw new Error("connect-station not found");

  // Wait for the composer to exist and be idle (opening finished), bounded.
  const idleDeadline = Date.now() + 90_000;
  let idleSince = null;
  while (Date.now() < idleDeadline) {
    const state = await cdp.eval(
      `(() => { const el = document.querySelector('.composer-input'); return el ? (el.disabled ? 'busy' : 'idle') : 'absent'; })()`,
    );
    if (state === "idle") {
      idleSince ??= Date.now();
      if (Date.now() - idleSince > 4000) break;
    } else idleSince = null;
    await sleep(700);
  }
  note(`composer idle: ${idleSince !== null}`);

  const sessions = await cdp.eval(`window.herta.listSessions()`);
  sessions.sort((a, b) =>
    String(b.updatedAt ?? b.createdAt ?? "").localeCompare(
      String(a.updatedAt ?? a.createdAt ?? ""),
    ),
  );
  const sid = sessions[0]?.id ?? sessions[0]?.sessionId;
  if (!sid) throw new Error(`no session id: ${JSON.stringify(sessions[0])}`);
  note(`session ${sid}`);

  const paths = [files.pdf, files.docx, files.scan, files.locked, files.doc];
  const t0 = Date.now();
  const res = await cdp.eval(
    `window.herta.attachFiles(${JSON.stringify(sid)}, ${JSON.stringify(paths)})`,
  );
  const ms = Date.now() - t0;
  note(`attachFiles → ${JSON.stringify(res)} in ${ms}ms`);
  report.attachResult = res;
  report.attachMs = ms;
  await sleep(1500);

  const rows = await cdp.eval(
    `(() => [...document.querySelectorAll('*')].map(e => e.childElementCount === 0 ? (e.textContent || '').trim() : '').filter(t => t.startsWith('附件 ')).filter((v, i, a) => a.indexOf(v) === i))()`,
  );
  report.rows = rows;
  console.log("  rendered rows:");
  for (const r of rows) console.log(`    · ${r}`);

  // Open the detail panes and capture the head excerpt of the PDF.
  await cdp.eval(
    `(() => { [...document.querySelectorAll('button')].filter(x => /明细|detail/i.test(x.textContent || '')).forEach(x => x.click()); return true; })()`,
  );
  await sleep(600);
  const detail = await cdp.eval(
    `(() => [...document.querySelectorAll('*')].map(e => e.childElementCount === 0 ? (e.textContent || '') : '').filter(t => t.includes('↳ 附件')).slice(0, 4))()`,
  );
  report.detail = detail;
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(OUT, "attach-probe.png"),
    Buffer.from(shot.data, "base64"),
  );

  // Expectations — the same rows the Windows live check produced.
  const expect = [
    [
      "pdf extracted",
      (r) => r.startsWith("附件 report.pdf · PDF · 2 页 · 已提取文本"),
    ],
    [
      "docx extracted",
      (r) => r.startsWith("附件 spec.docx · Word 文档 · 已提取文本"),
    ],
    [
      "scan → empty",
      (r) => r === "附件 scan.pdf · PDF · 2 页 · 未提取到文本，可能是扫描件",
    ],
    [
      "locked → encrypted",
      (r) => r === "附件 locked.pdf · PDF · 文档已加密，未取正文",
    ],
    [
      "legacy .doc → unsupported",
      (r) => r === "附件 legacy.doc · 暂不支持的文档格式",
    ],
    [
      "pdf head excerpt visible",
      () => detail.some((d) => d.includes("Findings on darwin")),
    ],
  ];
  report.checks = {};
  for (const [name, pred] of expect) {
    const ok = name.includes("head") ? pred() : rows.some(pred);
    report.checks[name] = ok;
    if (!ok) failed = true;
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  }
  if (res?.ok !== true) failed = true;
  cdp.ws.close();
} catch (err) {
  failed = true;
  report.error = String(err?.stack ?? err);
  console.log(`  probe error: ${report.error}`);
}

report.verdict = failed ? "FAIL" : "PASS";
writeFileSync(join(OUT, "attach-probe.json"), JSON.stringify(report, null, 2));
console.log(`\nMAC ATTACH PROBE: ${report.verdict}`);
process.exit(failed ? 1 : 0);
