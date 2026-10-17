import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import config from './config.js';
import AdsBridge from './ads-bridge.js';
import SimEngine from './engine.js';
import MappingStore from './mapping.js';
import SessionStore from './session.js';
import { scanTargets } from './ads-scan.js';
import { CONFIG_DIR } from './paths.js';
import { getScenario, scenarios } from '../shared/scenarios/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../web/dist');

const bridge = new AdsBridge();
const mapping = new MappingStore();
const session = new SessionStore();
const engine = new SimEngine(bridge, config, mapping);

const app = express();
app.use(express.json());

// --- REST:給不想用 WebSocket 的整合方式(例如另一支腳本要查狀態)---
app.get('/api/scenarios', (_req, res) => res.json(scenarios));
app.get('/api/state', (_req, res) => res.json({ engine: engine.state, ads: bridge.status }));
app.get('/api/symbols', async (_req, res) => {
  try {
    res.json(await bridge.listSymbols());
  } catch (err) {
    res.status(503).json({ error: err?.message ?? String(err) });
  }
});

// production 走 `npm run build` 產生的靜態檔;開發時由 Vite dev server 提供頁面
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res
      .status(200)
      .type('html')
      .send('<h3>模擬器後端執行中</h3><p>開發模式請開啟 Vite 的網址(預設 http://localhost:5173),或先執行 <code>npm run build</code>。</p>'),
  );
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

// --- 狀態推送:模擬週期可能比畫面更新快,這裡節流以免灌爆瀏覽器 ---
let lastPush = 0;
engine.on('tick', (state) => {
  const now = Date.now();
  if (now - lastPush < config.pushTime) return;
  lastPush = now;
  broadcast({ t: 'state', engine: state, ads: bridge.status });
});

engine.on('log', (entry) => broadcast({ t: 'log', ...entry, at: Date.now() }));
bridge.on('log', (entry) => broadcast({ t: 'log', ...entry, at: Date.now() }));
bridge.on('status', (status) => broadcast({ t: 'ads', ads: status }));

// --- WebSocket 指令處理 ---
const handlers = {
  async selectScenario(_ws, msg) {
    await engine.selectScenario(msg.id);
  },
  setParam(_ws, msg) {
    engine.setParam(msg.key, msg.value);
  },
  setOverride(_ws, msg) {
    engine.setOverride(msg.key, msg.value);
  },
  clearOverrides() {
    engine.clearOverrides();
  },
  command(_ws, msg) {
    engine.runCommand(msg.name, msg.args);
  },
  reset() {
    engine.resetModel();
  },
  setMode(_ws, msg) {
    engine.setMode(msg.mode);
  },
  start() {
    engine.start();
  },
  stop() {
    engine.stop();
  },
  async setMapping(_ws, msg) {
    await engine.setMapping(msg.key, msg.path);
  },
  async resetMapping() {
    await engine.resetMapping();
  },
  /** 樹狀瀏覽:path 留空取頂層,否則展開該節點 */
  async browseSymbols(ws, msg) {
    const path = msg.path ?? '';
    try {
      const children = await bridge.browseSymbol(path);
      send(ws, { t: 'symbolTree', path, children });
    } catch (err) {
      send(ws, { t: 'symbolTree', path, children: [], error: err?.message ?? String(err) });
      throw err;
    }
  },
  async fetchSymbols(ws) {
    // 一個 PLC 專案可能有上千個符號,只回給發出請求的那個連線
    try {
      send(ws, { t: 'symbols', list: await bridge.listSymbols() });
    } catch (err) {
      // 失敗也要回,否則前端會一直卡在「讀取中…」
      send(ws, { t: 'symbols', list: [], error: err?.message ?? String(err) });
      throw err;
    }
  },
  /** 列出本機 AMS Router 認得的目標,連線設定頁面用來省去手打 NetId */
  async scanTargets(ws) {
    try {
      send(ws, { t: 'scanResult', ...(await scanTargets()) });
    } catch (err) {
      // 失敗也要回,否則前端一直卡在「搜尋中…」
      send(ws, { t: 'scanResult', targets: [], error: err?.message ?? String(err) });
      throw err;
    }
  },
  async adsConnect(_ws, msg) {
    await bridge.connect({
      targetAmsNetId: msg.targetAmsNetId ?? config.ads.targetAmsNetId,
      targetAdsPort: Number(msg.targetAdsPort ?? config.ads.targetAdsPort),
      routerAddress: msg.routerAddress || undefined,
      routerTcpPort: Number(msg.routerTcpPort ?? config.ads.routerTcpPort),
    });
    if (engine.mode !== 'ads') engine.setMode('ads');
  },
  async adsDisconnect() {
    await bridge.disconnect();
  },
};

wss.on('connection', (ws) => {
  clients.add(ws);
  send(ws, {
    t: 'hello',
    scenarios,
    engine: engine.state,
    ads: bridge.status,
    defaults: { ads: config.ads, cycleTime: config.cycleTime, configDir: CONFIG_DIR },
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { t: 'log', level: 'error', message: '收到無法解析的訊息', at: Date.now() });
    }
    const handler = handlers[msg.t];
    if (!handler) {
      return send(ws, { t: 'log', level: 'warn', message: `未知的指令:${msg.t}`, at: Date.now() });
    }
    try {
      await handler(ws, msg);
      // 指令執行後立刻回推一次,不必等下個節流窗口,操作才跟手
      send(ws, { t: 'state', engine: engine.state, ads: bridge.status });
    } catch (err) {
      send(ws, { t: 'log', level: 'error', message: err?.message ?? String(err), at: Date.now() });
      send(ws, { t: 'state', engine: engine.state, ads: bridge.status });
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// --- 啟動 ---
async function main() {
  console.log(`[sim] 設定存放位置:${CONFIG_DIR}`);
  try {
    const dropped = mapping.prune(scenarios);
    if (dropped) console.log(`[sim] 清掉 ${dropped} 筆已不存在的 I/O 對映`);
  } catch (err) {
    // 清理不掉不影響操作,但寫不進去代表待會綁定也存不了,先講清楚
    console.warn(`[sim] ${err.message}`);
  }

  // SIM_SCENARIO 有指定就聽它的,否則回到上次用的場景。
  // 不記住的話,在龍門綁好 I/O 重開後會停在輸送帶,看起來就像綁定全消失了。
  const remembered = session.scenarioId;
  const startScenario =
    config.scenarioPinned || !remembered || !getScenario(remembered) ? config.defaultScenario : remembered;
  await engine.selectScenario(startScenario);
  engine.on('scenario', (id) => {
    session.scenarioId = id;
  });

  engine.start();

  server.listen(config.port, () => {
    console.log(`[sim] 模擬器已啟動:http://localhost:${config.port}`);
    console.log(`[sim] 場景:${engine.scenario?.name} / 週期:${config.cycleTime} ms`);
    if (!fs.existsSync(distDir)) {
      console.log('[sim] 尚未 build 前端,開發請另開 `npm run dev:web` 並使用 Vite 的網址');
    }

    // ADS 連線一律在 HTTP 起來之後才開始,而且不等它。
    // 反過來做的話,TwinCAT 沒開時整個網頁得等連線逾時才出得來 ——
    // 而連哪台 PLC 本來就能在網頁上隨時改,沒道理為了它把 UI 擋住。
    if (config.mode !== 'ads') return;

    console.log(`[sim] 嘗試連線 ${config.ads.targetAmsNetId}:${config.ads.targetAdsPort}(背景進行,不影響操作)`);
    bridge.connect(config.ads).catch(() => {
      // 學員常常是先開模擬器再開 TwinCAT,連不上很正常。
      // 切成手動模式至少三個場景都能完整操作,要連線隨時可以在網頁上按。
      engine.setMode('mock');
      console.log('[sim] 沒有連上 TwinCAT,先以手動模擬模式執行');
      console.log('[sim] 開好 TwinCAT 後,在網頁右上角「連線設定」按「連線」即可');
    });
  });
}

async function shutdown() {
  console.log('\n[sim] 關閉中...');
  engine.stop();
  await bridge.disconnect();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('[sim] 啟動失敗:', err);
  process.exit(1);
});
