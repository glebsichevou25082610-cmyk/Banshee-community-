const express = require('express');
const http = require('http');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;
const START_URL = process.env.START_URL || 'https://www.wikipedia.org';
// Если задан — управлять могут только те, кто ввёл этот пароль. Остальные только смотрят.
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';
const W = 1280;
const H = 720;

// ---------- защита от доступа к внутренней сети (SSRF) ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

const hostCache = new Map();
async function hostAllowed(host) {
  if (hostCache.has(host)) return hostCache.get(host);
  let ok = false;
  try {
    if (net.isIP(host)) ok = !isPrivateIp(host);
    else {
      const addrs = await dns.lookup(host, { all: true });
      ok = addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
    }
  } catch { ok = false; }
  hostCache.set(host, ok);
  setTimeout(() => hostCache.delete(host), 60_000);
  return ok;
}

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) {
    // не похоже на адрес — ищем в Google
    if (!u.includes('.') || u.includes(' ')) return 'https://www.google.com/search?q=' + encodeURIComponent(u);
    u = 'https://' + u;
  }
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null;
  } catch { return null; }
}

// ---------- общий браузер ----------
const clients = new Set();
let page, cdp;
let lastFrame = null;
let state = { url: START_URL, title: '' };

function broadcastJson(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

async function startBrowser() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: W, height: H } });

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return route.continue();
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.abort();
    if (!(await hostAllowed(url.hostname))) return route.abort();
    return route.continue();
  });

  page = await context.newPage();
  page.on('framenavigated', async (f) => {
    if (f !== page.mainFrame()) return;
    state = { url: page.url(), title: await page.title().catch(() => '') };
    broadcastJson({ t: 'state', ...state });
  });
  page.on('load', async () => {
    state.title = await page.title().catch(() => '');
    broadcastJson({ t: 'state', ...state });
  });

  cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    lastFrame = Buffer.from(data, 'base64');
    for (const ws of clients) if (ws.readyState === 1 && ws.bufferedAmount < 2_000_000) ws.send(lastFrame);
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

  await page.goto(START_URL).catch(() => {});
}

// Все действия выполняются по очереди, чтобы не мешать друг другу
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.error('action error:', e.message));
}

function handleAction(m) {
  const clamp = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
  switch (m.t) {
    case 'click': return page.mouse.click(clamp(m.x, W), clamp(m.y, H), { button: m.button === 2 ? 'right' : 'left' });
    case 'move': return page.mouse.move(clamp(m.x, W), clamp(m.y, H));
    case 'wheel': return page.mouse.wheel(Number(m.dx) || 0, Number(m.dy) || 0);
    case 'text': return page.keyboard.insertText(String(m.text).slice(0, 500));
    case 'key': return page.keyboard.press(String(m.key).slice(0, 50));
    case 'goto': {
      const u = normalizeUrl(m.url);
      return u && page.goto(u, { timeout: 20000 }).catch(() => {});
    }
    case 'back': return page.goBack().catch(() => {});
    case 'forward': return page.goForward().catch(() => {});
    case 'reload': return page.reload().catch(() => {});
  }
}

// ---------- HTTP + WebSocket ----------
const app = express();
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.canControl = !CONTROL_TOKEN;
  clients.add(ws);
  ws.send(JSON.stringify({ t: 'hello', w: W, h: H, canControl: ws.canControl, needsToken: !!CONTROL_TOKEN, ...state }));
  if (lastFrame) ws.send(lastFrame);
  broadcastJson({ t: 'viewers', n: clients.size });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'auth') {
      ws.canControl = !CONTROL_TOKEN || m.token === CONTROL_TOKEN;
      ws.send(JSON.stringify({ t: 'auth', ok: ws.canControl }));
      return;
    }
    if (!ws.canControl) return;
    enqueue(() => handleAction(m));
  });
  ws.on('close', () => {
    clients.delete(ws);
    broadcastJson({ t: 'viewers', n: clients.size });
  });
});

startBrowser()
  .then(() => server.listen(PORT, () => console.log(`Shared browser: http://localhost:${PORT}`)))
  .catch((e) => { console.error('Failed to start browser:', e); process.exit(1); });
