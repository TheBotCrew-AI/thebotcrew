/**
 * Battery transcripts → WhatsApp-style screenshots.
 *
 * Reads `battery/<slug>/*.json` (written by `pnpm battery <slug>`), renders each
 * conversation as the lead's phone would show it (iPhone, WhatsApp light theme), and
 * screenshots it screen by screen with the Chrome already installed on the machine —
 * no npm dependency. Also writes an `index.html` gallery with the notes that must NOT
 * be in the picture (what each scenario shows, which tools fired, what got booked).
 *
 *   pnpm battery:render heriberto
 *   pnpm battery:render heriberto --only lead-bueno-botox
 *   pnpm battery:render heriberto --avatar ../sites/dr-valdivia/img/logo.png   # profile photo
 *   pnpm battery:render heriberto --no-png                                    # HTML only
 *
 * Output: battery/<slug>/render/<id>.html, <id>-1.png, <id>-2.png …, index.html (Leo's gallery,
 * with the tool calls) and reporte.html (the client's one-page: swipe through the conversations,
 * each one replays like a live chat — see lib/battery-report.mjs).
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { esc, wa, timeLabel, initials, avatarDataUri, ICON, css } from './lib/whatsapp-ui.mjs';
import { reportHtml } from './lib/battery-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('--'));
if (!slug) {
  console.error('uso: pnpm battery:render <tenant-slug> [--only id,id] [--avatar file] [--no-png]');
  process.exit(2);
}
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);
const only = (flag('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const OUT = resolve(__dirname, `../battery/${slug}`);
const RENDER = resolve(OUT, 'render');
mkdirSync(RENDER, { recursive: true });

/**
 * Which browser takes the screenshots. A `chrome-headless-shell` (the Chrome build made for
 * exactly this) is preferred over the desktop app: on Leo's Mac, any headless Google Chrome
 * process gets a SIGTERM from something on the machine ~2 s after launch (verified 2026-08-29
 * with `--enable-logging --v=1`: "Handling shutdown for signal 15", even detached, even
 * without remote debugging), so a render longer than two seconds died mid-run. The shell
 * binary is left alone. Order: CHROME_BIN → puppeteer's cache → playwright's cache → the app.
 * To get a shell:  npx @puppeteer/browsers install chrome-headless-shell@stable
 */
function findBrowser() {
  if (process.env.CHROME_BIN) return { bin: process.env.CHROME_BIN, shell: /headless.shell/i.test(process.env.CHROME_BIN) };
  const home = homedir();
  const caches = [
    resolve(home, '.cache/puppeteer/chrome-headless-shell'),
    resolve(home, 'Library/Caches/ms-playwright'),
  ];
  for (const dir of caches) {
    if (!existsSync(dir)) continue;
    for (const v of readdirSync(dir).filter((d) => /headless/i.test(d) || /^mac|^linux|^win/.test(d)).sort().reverse()) {
      const inner = resolve(dir, v);
      for (const sub of readdirSync(inner)) {
        const bin = resolve(inner, sub, 'chrome-headless-shell');
        if (existsSync(bin)) return { bin, shell: true };
      }
    }
  }
  return { bin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', shell: false };
}
const BROWSER = findBrowser();
const CHROME = BROWSER.bin;
const W = 390;
const H = 844;
const SCALE = 3;

// ---------------------------------------------------------------------------------------

function bubblesHtml(transcript) {
  const tz = transcript.tenant.timezone;
  const out = [];
  let prev = null;
  for (const m of transcript.messages) {
    const side = m.from === 'lead' ? 'out' : 'in';
    const first = prev !== side ? ' first' : '';
    const meta = `<span class="meta">${timeLabel(m.at, tz)}${side === 'out' ? ICON.ticks : ''}</span>`;
    // The spacer reserves the time's width at the end of the last line, WhatsApp-style.
    out.push(`<div class="msg ${side}${first}">${wa(m.text)}<span class="spacer"></span>${meta}</div>`);
    prev = side;
  }
  return out.join('\n');
}

function pageHtml(transcript, avatar) {
  const name = transcript.tenant.businessName;
  const avatarInner = avatar ? `<img src="${avatar}" alt="">` : esc(initials(name));
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${esc(transcript.scenario.title)}</title><style>${css(W, H)}</style></head>
<body>
<div class="phone">
  <div class="top">
    <div class="statusbar"><span>9:41</span>${ICON.status}</div>
    <div class="header">
      <div class="back">${ICON.back}<span class="unread">3</span></div>
      <div class="avatar">${avatarInner}</div>
      <div class="who"><div class="name"><span>${esc(name)}</span>${ICON.verified}</div><div class="sub">Cuenta de empresa</div></div>
      <div class="actions">${ICON.video}${ICON.phone}</div>
    </div>
  </div>
  <div class="chat" id="chat">
    <div class="pill">Hoy</div>
    <div class="pill notice">🔒 Esta empresa utiliza un servicio seguro de Meta para gestionar este chat. Toca para más información.</div>
${bubblesHtml(transcript)}
  </div>
  <div class="composer">
    <div class="row">${ICON.plus}<div class="input"><span>Mensaje</span>${ICON.sticker}</div>${ICON.camera}${ICON.mic}</div>
    <div class="home"></div>
  </div>
</div>
<script>
(function () {
  // Screen-by-screen pagination: whole bubbles only, greedy from the top; the last screen
  // sits at the bottom, the way a chat looks when you open it.
  var chat = document.getElementById('chat');
  var items = Array.prototype.slice.call(chat.children);
  var avail = chat.clientHeight - 16;
  var pages = [[]], used = 0;
  items.forEach(function (el) {
    var cs = getComputedStyle(el);
    var h = el.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    if (used + h > avail && pages[pages.length - 1].length) { pages.push([]); used = 0; }
    pages[pages.length - 1].push(el); used += h;
  });
  document.documentElement.setAttribute('data-pages', String(pages.length));
  var want = parseInt(new URLSearchParams(location.search).get('page') || '0', 10);
  if (want >= 1) {
    var show = pages[Math.min(want, pages.length) - 1];
    items.forEach(function (el) { if (show.indexOf(el) < 0) el.style.display = 'none'; });
    if (want >= pages.length) chat.classList.add('bottom');
    // A screen that starts mid-conversation shows a continuation tail on its first bubble.
    var firstMsg = show.filter(function (el) { return el.classList.contains('msg'); })[0];
    if (firstMsg) firstMsg.classList.add('first');
  }
})();
</script>
</body></html>
`;
}

/**
 * Chrome driven over the DevTools protocol (one process for every screen). Chrome 151's
 * `--screenshot` command path crashes (NOTREACHED in headless_command_processor) on
 * most runs, so the page is loaded and captured through CDP instead — plain WebSocket,
 * still no dependency.
 */
async function withChrome(fn) {
  const profile = mkdtempSync(resolve(tmpdir(), 'battery-chrome-'));
  const proc = spawn(CHROME, [
    ...(BROWSER.shell ? [] : ['--headless=new']), '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${W},${H}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const wsUrl = await new Promise((ok, fail) => {
    proc.stderr.on('data', () => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) ok(m[1]);
    });
    proc.on('exit', (code) => fail(new Error(`Chrome salió antes de abrir DevTools (código ${code})\n${stderr}`)));
    setTimeout(() => fail(new Error('Chrome no abrió DevTools en 15 s')), 15_000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = (e) => fail(new Error(`CDP websocket: ${e.message ?? e.error ?? e.type}`)); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  const abort = (why) => {
    for (const { fail } of pending.values()) fail(new Error(`${why}\n${stderr.split('\n').filter((l) => !/crashpad|allocator/.test(l)).slice(-8).join('\n')}`));
    pending.clear();
  };
  ws.onclose = (ev) => abort(`CDP: Chrome cerró la conexión (code=${ev.code} reason=${JSON.stringify(ev.reason)} wasClean=${ev.wasClean})`);
  proc.on('exit', (code) => abort(`CDP: Chrome terminó (código ${code})`));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(new Error(`${msg.error.message}`)) : ok(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      const msgId = ++id;
      pending.set(msgId, { ok, fail });
      ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
    });
  const waitFor = (method, sessionId) =>
    new Promise((ok) => {
      const l = (msg) => {
        if (msg.method === method && msg.sessionId === sessionId) { listeners.splice(listeners.indexOf(l), 1); ok(msg.params); }
      };
      listeners.push(l);
    });
  try {
    // Use the tab Chrome opened at startup rather than creating one: right after
    // "DevTools listening" the browser is not always ready, and both createTarget
    // ("Failed to open a new tab") and attachToTarget ("No target with given id") flake.
    let sessionId;
    for (let attempt = 0; ; attempt++) {
      try {
        const { targetInfos } = await send('Target.getTargets');
        const page = targetInfos.find((t) => t.type === 'page');
        if (!page) throw new Error('no page target yet');
        ({ sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true }));
        break;
      } catch (err) {
        if (attempt >= 40) throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true }, sessionId);
    const page = {
      async open(url) {
        const loaded = waitFor('Page.loadEventFired', sessionId);
        await send('Page.navigate', { url }, sessionId);
        await loaded;
      },
      async eval(expression) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
        return r.result.value;
      },
      async png(file) {
        // Let fonts and emoji settle after load.
        await send('Runtime.evaluate', { expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true }, sessionId);
        // The 3x comes from the clip, not the device scale: on Chrome 151 the DPR override
        // changed the capture size but not the layout viewport (a 1x phone in a 3x canvas).
        const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: SCALE } }, sessionId);
        writeFileSync(file, Buffer.from(data, 'base64'));
      },
    };
    return await fn(page);
  } finally {
    ws.close();
    const gone = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await gone;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function screenshots(page, htmlPath, id) {
  const url = pathToFileURL(htmlPath).href;
  await page.open(url);
  const pages = Number((await page.eval("document.documentElement.getAttribute('data-pages')")) ?? 1);
  const files = [];
  for (let p = 1; p <= pages; p++) {
    const png = resolve(RENDER, `${id}-${p}.png`);
    await page.open(`${url}?page=${p}`);
    await page.png(png);
    files.push(png);
  }
  return files;
}

function galleryHtml(entries) {
  const card = (e) => {
    const t = e.transcript;
    const tools = t.toolCalls.length
      ? `<ul>${t.toolCalls.map((c) => `<li><code>${esc(c.name)}</code> <small>${esc(JSON.stringify(c.args ?? {}))}</small></li>`).join('')}</ul>`
      : '<p><em>sin herramientas</em></p>';
    const appts = t.ghl.appointments.length
      ? t.ghl.appointments.map((a) => `${a.status === 'cancelled' ? '❌' : '✅'} ${esc(a.serviceName ?? '')} — ${esc(a.startTime)}`).join('<br>')
      : '—';
    const shots = e.pngs.length
      ? e.pngs.map((p) => `<img src="${esc(p)}" alt="">`).join('')
      : `<iframe src="${esc(e.html)}" width="${W}" height="${H}"></iframe>`;
    return `<section>
  <h2>${esc(t.scenario.title)} <small>${esc(t.scenario.id)}</small></h2>
  <p class="shows">${esc(t.scenario.shows)}</p>
  <div class="cols">
    <div class="shots">${shots}</div>
    <aside>
      <h3>Qué pasó</h3>
      <p>Lead: <b>${esc(t.scenario.lead.name)}</b> · ${t.messages.filter((m) => m.from === 'lead').length} mensajes del lead · terminó por <code>${t.endedBy}</code></p>
      <p>Citas: ${appts}</p>
      <p>Tags: ${t.ghl.tags.length ? t.ghl.tags.map((x) => `<code>${esc(x)}</code>`).join(' ') : '—'} · Nombre guardado: ${esc(t.ghl.contactName ?? '—')}</p>
      <h3>Herramientas</h3>${tools}
      <p class="fine">bot: ${esc(t.model)} · lead: ${esc(t.leadModel)} · config: ${esc(t.tenant.configSource)} · ${esc(t.generatedAt)}</p>
    </aside>
  </div>
</section>`;
  };
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Batería — ${esc(slug)}</title>
<style>
body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;padding:24px 32px;background:#f4f4f5;color:#111}
h1{font-size:22px} h2{font-size:18px;margin:36px 0 4px} h2 small{color:#888;font-weight:400;font-size:13px}
.shows{color:#444;max-width:820px;margin:0 0 14px}
.cols{display:flex;gap:28px;align-items:flex-start}
.shots{display:flex;gap:14px;flex-wrap:wrap} .shots img{width:${W * 0.6}px;border-radius:24px;box-shadow:0 4px 18px rgba(0,0,0,.18)}
aside{flex:1 1 320px;background:#fff;border-radius:12px;padding:14px 18px;font-size:14px;line-height:1.45}
aside h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#777;margin:12px 0 4px}
code{background:#eee;padding:1px 5px;border-radius:4px;font-size:12.5px} ul{padding-left:18px;margin:4px 0} small{color:#666;word-break:break-all} .fine{color:#888;font-size:12px}
</style></head><body>
<h1>Batería de conversaciones — ${esc(entries[0]?.transcript.tenant.businessName ?? slug)}</h1>
<p class="shows">Los PNG son lo que se manda; esta página es para ti. Regenerar: <code>pnpm battery ${esc(slug)}</code> → <code>pnpm battery:render ${esc(slug)}</code>.</p>
${entries.map(card).join('\n')}
</body></html>
`;
}

// ---------------------------------------------------------------------------------------

const avatar = avatarDataUri(flag('avatar'));
const files = readdirSync(OUT)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, t: JSON.parse(readFileSync(resolve(OUT, f), 'utf8')) }))
  .sort((a, b) => (a.t.scenario.order ?? 99) - (b.t.scenario.order ?? 99) || a.f.localeCompare(b.f));
const jobs = [];
for (const { t: transcript } of files) {
  const id = transcript.scenario.id;
  if (only.length && !only.includes(id)) continue;
  const htmlPath = resolve(RENDER, `${id}.html`);
  writeFileSync(htmlPath, pageHtml(transcript, avatar));
  jobs.push({ transcript, id, htmlPath });
}
if (!jobs.length) {
  console.error(`nada que renderizar en ${OUT} — corre \`pnpm battery ${slug}\` primero`);
  process.exit(1);
}

const entries = [];
const render = async (page) => {
  for (const job of jobs) {
    const pngs = page ? (await screenshots(page, job.htmlPath, job.id)).map((p) => p.slice(RENDER.length + 1)) : [];
    entries.push({ transcript: job.transcript, html: `${job.id}.html`, pngs });
    console.log(`${job.id}: ${pngs.length ? `${pngs.length} pantalla/s` : 'html'}`);
  }
};
if (has('no-png')) {
  await render(null);
} else {
  if (!existsSync(CHROME)) {
    console.error(`navegador no encontrado (${CHROME}) — instala uno con \`npx @puppeteer/browsers install chrome-headless-shell@stable\`, pon CHROME_BIN, o usa --no-png`);
    process.exit(1);
  }
  console.log(`navegador: ${CHROME}`);
  await withChrome(render);
}
writeFileSync(resolve(RENDER, 'index.html'), galleryHtml(entries));
writeFileSync(resolve(RENDER, 'reporte.html'), reportHtml(entries.map((e) => e.transcript), { avatar }));
console.log(`galería (para ti): ${resolve(RENDER, 'index.html')}`);
console.log(`reporte (para el cliente): ${resolve(RENDER, 'reporte.html')}`);
