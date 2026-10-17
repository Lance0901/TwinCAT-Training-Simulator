import './style.css';
import { SceneHost } from './scenes/index.js';
import {
  IoPanel,
  ParamPanel,
  MappingPanel,
  Hud,
  buildCommands,
  buildCoordTables,
  coordTablesToSt,
  renderCoordTables,
  buildScenarioTabs,
  setActiveTab,
  appendLog,
  updateConnBadge,
} from './ui.js';

const dom = {
  tabs: document.getElementById('scenario-tabs'),
  subtitle: document.getElementById('scenario-subtitle'),
  conn: document.getElementById('conn-badge'),
  viewport: document.getElementById('viewport'),
  hud: document.getElementById('viewport-hud'),
  outputs: document.getElementById('io-outputs'),
  inputs: document.getElementById('io-inputs'),
  actuatorHint: document.getElementById('actuator-hint'),
  params: document.getElementById('params'),
  commands: document.getElementById('commands'),
  log: document.getElementById('log'),
  statCycle: document.getElementById('stat-cycle'),
  dialog: document.getElementById('settings-dialog'),
  cfgNetId: document.getElementById('cfg-netid'),
  cfgPort: document.getElementById('cfg-port'),
  cfgRouter: document.getElementById('cfg-router'),
  mappingDialog: document.getElementById('mapping-dialog'),
  mappingList: document.getElementById('mapping-list'),
  mappingScenario: document.getElementById('mapping-scenario'),
  mappingConfigDir: document.getElementById('mapping-config-dir'),
  scanStatus: document.getElementById('scan-status'),
  scanList: document.getElementById('scan-list'),
  symbolCount: document.getElementById('symbol-count'),
  coordsDialog: document.getElementById('coords-dialog'),
  coordsBody: document.getElementById('coords-body'),
  coordsScenario: document.getElementById('coords-scenario'),
  coordsHint: document.getElementById('coords-hint'),
  copyStatus: document.getElementById('copy-status'),
};

/** 目前場景的格位座標,座標表與「複製 ST」共用 */
let coordTables = [];

const state = {
  scenarios: [],
  scenarioId: null,
  engine: null,
  ads: null,
  defaults: null,
  wsConnected: false,
};

// ---------------------------------------------------------------- WebSocket

let ws = null;
let reconnectTimer = null;

function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    state.wsConnected = true;
    refreshBadge();
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === 'hello') onHello(msg);
    else if (msg.t === 'state') onState(msg);
    else if (msg.t === 'ads') {
      state.ads = msg.ads;
      refreshBadge();
    } else if (msg.t === 'symbols') {
      onSymbols(msg.list, msg.error);
    } else if (msg.t === 'scanResult') {
      onScanResult(msg);
    } else if (msg.t === 'symbolTree') {
      const pending = pendingBrowse.get(msg.path);
      pendingBrowse.delete(msg.path);
      if (msg.error) pending?.reject(new Error(msg.error));
      else pending?.resolve(msg.children);
    } else if (msg.t === 'log') {
      appendLog(dom.log, msg);
    }
  };

  ws.onclose = () => {
    state.wsConnected = false;
    refreshBadge();
    // 後端重啟時自動接回來,學員不用手動重新整理
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1500);
    }
  };

  ws.onerror = () => ws.close();
}

// ---------------------------------------------------------------- 面板

const hud = new Hud(dom.hud);
const sceneHost = new SceneHost(dom.viewport, hud);

const outputPanel = new IoPanel(dom.outputs, 'output', {
  onOverride: (key, value) => send({ t: 'setOverride', key, value }),
});
const inputPanel = new IoPanel(dom.inputs, 'input');
const paramPanel = new ParamPanel(dom.params, (key, value) => send({ t: 'setParam', key, value }));
/**
 * 樹狀瀏覽的請求/回應配對。
 * 每個路徑同時只會有一個展開請求在飛,用 path 當 key 就夠了。
 */
const pendingBrowse = new Map();

function browseSymbols(path) {
  return new Promise((resolve, reject) => {
    pendingBrowse.set(path, { resolve, reject });
    send({ t: 'browseSymbols', path });
    setTimeout(() => {
      if (pendingBrowse.has(path)) {
        pendingBrowse.delete(path);
        reject(new Error('讀取逾時'));
      }
    }, 20000);
  });
}

// 下拉必須掛在 dialog 內部:showModal() 會把 dialog 推進 top layer,
// 掛在外面的元素不管 z-index 多高都會被蓋住。
const mappingPanel = new MappingPanel(dom.mappingList, dom.mappingDialog, {
  onChange: (key, path) => send({ t: 'setMapping', key, path }),
  onBrowse: browseSymbols,
});

function currentScenario() {
  return state.scenarios.find((s) => s.id === state.scenarioId);
}

function onHello(msg) {
  state.scenarios = msg.scenarios;
  state.defaults = msg.defaults;
  buildScenarioTabs(dom.tabs, state.scenarios, msg.engine?.scenario, (id) =>
    send({ t: 'selectScenario', id }),
  );
  dom.cfgNetId.value = msg.defaults?.ads?.targetAmsNetId ?? '127.0.0.1.1.1';
  dom.cfgPort.value = msg.defaults?.ads?.targetAdsPort ?? 851;
  dom.cfgRouter.value = msg.defaults?.ads?.routerAddress ?? '';
  if (msg.defaults?.configDir) dom.mappingConfigDir.textContent = msg.defaults.configDir;
  onState(msg);
}

function onState(msg) {
  state.engine = msg.engine;
  state.ads = msg.ads;

  const scenarioChanged = state.scenarioId !== msg.engine?.scenario;
  if (scenarioChanged) {
    state.scenarioId = msg.engine?.scenario;
    rebuildForScenario();
  }

  const scenario = currentScenario();
  if (!scenario) return;

  const mock = msg.engine.mode === 'mock';
  outputPanel.update(msg.engine.outputs, msg.engine.overrides, !mock);
  inputPanel.update(msg.engine.inputs);
  paramPanel.sync(msg.engine.params);
  sceneHost.update(msg);

  // I/O 表帶著即時值,關著的時候沒必要更新
  if (dom.mappingDialog.open) {
    mappingPanel.update(msg.engine.mapping, msg.engine.mappingOverrides, msg.ads?.bindStatus, {
      ...msg.engine.outputs,
      ...msg.engine.inputs,
    });
  }

  const stats = msg.engine.stats ?? {};
  dom.statCycle.textContent =
    `週期 ${msg.engine.cycleTime} ms · 實測 ${(stats.cycleMs ?? 0).toFixed(1)} ms` +
    `${msg.engine.mode === 'ads' ? ` · ADS ${(stats.adsMs ?? 0).toFixed(1)} ms` : ''}` +
    ` · tick ${msg.engine.tick}`;

  refreshBadge();
}

function rebuildForScenario() {
  const scenario = currentScenario();
  if (!scenario) return;

  setActiveTab(dom.tabs, scenario.id, state.scenarios);
  dom.subtitle.textContent = `${scenario.subtitle} — ${scenario.topics.join(' · ')}`;

  const mock = state.engine?.mode === 'mock';
  outputPanel.build(scenario.outputs, { editable: true });
  inputPanel.build(scenario.inputs, { editable: false });
  paramPanel.build(scenario.params, state.engine?.params ?? {});
  buildCommands(dom.commands, scenario.commands, (name) => send({ t: 'command', name }));
  updateActuatorHint(mock);

  dom.mappingScenario.textContent = scenario.name;
  mappingPanel.build(scenario, state.engine?.mapping ?? {});

  coordTables = buildCoordTables(scenario);
  dom.coordsScenario.textContent = scenario.name;
  dom.coordsHint.textContent = coordTables.length
    ? '這些是機構上各格位的實際座標,單位 mm。寫定位程式時直接用這組數字,不必自己從畫面上估。'
    : '此場景沒有格位座標。';
  renderCoordTables(dom.coordsBody, coordTables);

  sceneHost.load(scenario);
}

function onSymbols(list, error) {
  mappingPanel.setSymbols(list);
  if (error) {
    dom.symbolCount.textContent = `讀取失敗:${error}`;
    dom.symbolCount.classList.add('stat-error');
  } else {
    dom.symbolCount.textContent = `PLC 共 ${list.length} 個可用變數,輸入框已可下拉選擇`;
    dom.symbolCount.classList.remove('stat-error');
  }
}

function updateActuatorHint(mock) {
  dom.actuatorHint.textContent = mock
    ? '手動模擬模式:這裡的開關直接驅動物理模型,不經過 PLC。'
    : '值由 PLC 寫入。直接操作可暫時覆寫,點右側的 ● 交還給 PLC。';
}

function refreshBadge() {
  updateConnBadge(dom.conn, {
    wsConnected: state.wsConnected,
    mode: state.engine?.mode,
    ads: state.ads,
  });
  updateActuatorHint(state.engine?.mode === 'mock');
}

// ---------------------------------------------------------------- 事件

document.getElementById('btn-reset').addEventListener('click', () => send({ t: 'reset' }));
document.getElementById('btn-clear-overrides').addEventListener('click', () => send({ t: 'clearOverrides' }));
document.getElementById('btn-clear-log').addEventListener('click', () => {
  dom.log.innerHTML = '';
});

document.getElementById('btn-settings').addEventListener('click', () => dom.dialog.showModal());

document.getElementById('btn-mapping').addEventListener('click', () => {
  const scenario = currentScenario();
  if (scenario) {
    // 重建一次確保切換場景後內容正確,並立刻填上目前的值
    mappingPanel.build(scenario, state.engine?.mapping ?? {});
    mappingPanel.update(state.engine?.mapping, state.engine?.mappingOverrides, state.ads?.bindStatus, {
      ...state.engine?.outputs,
      ...state.engine?.inputs,
    });
  }
  dom.mappingDialog.showModal();
});

document.getElementById('btn-mapping-close').addEventListener('click', () => dom.mappingDialog.close());

document.getElementById('btn-coords').addEventListener('click', () => {
  dom.copyStatus.textContent = '';
  dom.coordsDialog.showModal();
});

document.getElementById('btn-coords-close').addEventListener('click', () => dom.coordsDialog.close());

document.getElementById('btn-copy-st').addEventListener('click', async () => {
  const text = coordTablesToSt(coordTables);
  try {
    await navigator.clipboard.writeText(text);
    dom.copyStatus.textContent = '已複製到剪貼簿';
  } catch {
    // 沒有剪貼簿權限(非 https 或瀏覽器擋下)時,退而求其次讓使用者自己選取
    dom.copyStatus.textContent = '無法自動複製,已改為顯示內容';
    const pre = document.createElement('pre');
    pre.className = 'coord-st';
    pre.textContent = text;
    dom.coordsBody.prepend(pre);
    pre.scrollIntoView({ block: 'nearest' });
  }
});

document.getElementById('btn-fetch-symbols').addEventListener('click', () => {
  dom.symbolCount.textContent = '讀取中…';
  send({ t: 'fetchSymbols' });
});

document.getElementById('btn-scan').addEventListener('click', () => {
  dom.scanStatus.textContent = '搜尋中…';
  dom.scanStatus.classList.remove('stat-error');
  dom.scanList.innerHTML = '';
  send({ t: 'scanTargets' });
});

/** 點清單就把 NetId 填進欄位 —— 這功能的重點就是不用手打 */
function onScanResult({ targets = [], error }) {
  if (error) {
    dom.scanStatus.textContent = error;
    dom.scanStatus.classList.add('stat-error');
    return;
  }

  const usable = targets.filter((t) => t.reachable).length;
  dom.scanStatus.textContent = `找到 ${targets.length} 個目標,其中 ${usable} 個有回應`;
  dom.scanList.innerHTML = '';

  for (const t of targets) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `scan-item${t.reachable ? '' : ' unreachable'}`;
    row.title = t.reachable
      ? `TwinCAT 系統:${t.system ?? '未知'} / PLC Runtime:${t.plc ?? '無'}`
      : t.error ?? '沒有回應';

    let badge;
    if (!t.reachable) badge = '無回應';
    else if (t.plc === 'Run') badge = 'PLC 執行中';
    else if (t.system === 'Config') badge = 'Config 模式';
    else badge = t.plc ? `PLC ${t.plc}` : '無 PLC';

    row.innerHTML =
      `<span class="scan-netid">${t.netId}</span>` +
      `<span class="scan-name">${t.name || ''}${t.address ? ` · ${t.address}` : ''}</span>` +
      `<span class="scan-badge${t.plc === 'Run' ? ' ok' : ''}">${badge}</span>`;

    row.addEventListener('click', () => {
      dom.cfgNetId.value = t.netId;
      dom.scanList.querySelectorAll('.scan-item').forEach((el) => el.classList.remove('selected'));
      row.classList.add('selected');
    });
    dom.scanList.appendChild(row);
  }
}

document.getElementById('btn-reset-mapping').addEventListener('click', () => {
  send({ t: 'resetMapping' });
});

document.getElementById('btn-connect').addEventListener('click', () => {
  send({
    t: 'adsConnect',
    targetAmsNetId: dom.cfgNetId.value.trim(),
    targetAdsPort: Number(dom.cfgPort.value),
    routerAddress: dom.cfgRouter.value.trim(),
  });
  dom.dialog.close();
});

document.getElementById('btn-disconnect').addEventListener('click', () => {
  send({ t: 'adsDisconnect' });
  dom.dialog.close();
});

document.getElementById('btn-mock').addEventListener('click', () => {
  send({ t: 'setMode', mode: 'mock' });
  dom.dialog.close();
});

// 切走分頁時停掉 render loop,回來再啟動 — 背景分頁沒必要燒 GPU
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sceneHost.current?.stop();
  else sceneHost.current?.start();
});

// 開放給瀏覽器 console 排查:__sim.state 看目前狀態,__sim.send({...}) 手動送指令
window.__sim = { state, sceneHost, send, mappingPanel, currentScenario };

connect();
