import { EventEmitter } from 'node:events';
import { getScenario, scenarios } from '../shared/scenarios/index.js';
import { createModelFor } from './scenarios/index.js';
import { coerceValue, defaultValue } from './ads-codec.js';

/**
 * 模擬引擎。每個週期做三件事:
 *
 *   1. 讀 PLC 的致動器命令(或在 mock 模式讀網頁上的手動開關)
 *   2. 推進物理模型一個時間步
 *   3. 把感測器結果寫回 PLC,並把視覺化狀態推給網頁
 *
 * 用自我排程的 setTimeout 而非 setInterval:ADS 往返偶爾會超過週期時間,
 * setInterval 會讓回呼堆積,setTimeout 則自然退讓。
 */
export class SimEngine extends EventEmitter {
  constructor(bridge, config, mapping) {
    super();
    this.bridge = bridge;
    this.config = config;
    this.mapping = mapping;
    this.mode = config.mode;
    this.cycleTime = config.cycleTime;

    this.scenario = null;
    this.model = null;
    this.params = {};
    /** key → 手動覆寫值。ads 模式下會蓋掉 PLC 的值;mock 模式下這就是唯一的命令來源 */
    this.overrides = new Map();

    this.running = false;
    this.timer = null;
    this.lastTime = 0;
    this.tick = 0;

    this.outputs = {};
    this.inputs = {};
    this.view = {};
    this.stats = { cycleMs: 0, adsMs: 0, errors: 0, lastError: null, writes: 0 };
  }

  get state() {
    return {
      mode: this.mode,
      running: this.running,
      cycleTime: this.cycleTime,
      scenario: this.scenario?.id ?? null,
      params: { ...this.params },
      overrides: Object.fromEntries(this.overrides),
      tick: this.tick,
      outputs: this.outputs,
      inputs: this.inputs,
      view: this.view,
      stats: this.stats,
      mapping: this.scenario ? this.mapping.resolveAll(this.scenario) : {},
      mappingOverrides: this.scenario ? this.mapping.overridesFor(this.scenario) : {},
    };
  }

  log(level, message) {
    this.emit('log', { level, message });
  }

  /** 切換場景:重建物理模型、還原預設參數、清掉覆寫、重新綁定 ADS 符號 */
  async selectScenario(id) {
    const scenario = getScenario(id);
    if (!scenario) throw new Error(`未知的場景:${id}`);

    this.scenario = scenario;
    this.model = createModelFor(id);
    this.params = Object.fromEntries(scenario.params.map((p) => [p.key, p.default]));
    this.overrides.clear();
    // mock 模式沒有 PLC 下命令,先給每個致動器一個型別預設值當起點
    if (this.mode === 'mock') {
      for (const signal of scenario.outputs) {
        this.overrides.set(signal.key, defaultValue(signal.type));
      }
    }
    this.model.reset(this.params);
    this.tick = 0;
    this.outputs = Object.fromEntries(scenario.outputs.map((s) => [s.key, defaultValue(s.type)]));
    this.inputs = {};
    this.view = {};

    await this.bridge.bind(scenario, this.mapping.resolveAll(scenario));
    this.log('info', `已載入場景:${scenario.name}`);
    this.emit('scenario', scenario.id);
    return this.scenario;
  }

  /** 改接某個訊號到別的 PLC 變數;path 留空恢復預設 */
  async setMapping(signalKey, plcPath) {
    if (!this.scenario) throw new Error('尚未載入場景');
    const resolved = this.mapping.set(this.scenario, signalKey, plcPath);
    await this.bridge.bind(this.scenario, this.mapping.resolveAll(this.scenario));
    this.log('info', `訊號「${signalKey}」已改接到 ${resolved}`);
    return resolved;
  }

  async resetMapping() {
    if (!this.scenario) throw new Error('尚未載入場景');
    this.mapping.reset(this.scenario);
    await this.bridge.bind(this.scenario, this.mapping.resolveAll(this.scenario));
    this.log('info', `場景「${this.scenario.name}」的 I/O 對映已全部恢復預設`);
  }

  setParam(key, value) {
    const def = this.scenario?.params.find((p) => p.key === key);
    if (!def) throw new Error(`場景沒有參數「${key}」`);
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`參數「${key}」必須是數值`);
    this.params[key] = Math.min(def.max, Math.max(def.min, num));
    return this.params[key];
  }

  /** value 為 null 代表解除覆寫,交還給 PLC 控制 */
  setOverride(key, value) {
    const signal = this.scenario?.outputs.find((s) => s.key === key);
    if (!signal) throw new Error(`場景沒有致動器訊號「${key}」`);
    if (value === null || value === undefined) {
      this.overrides.delete(key);
      return null;
    }
    const coerced = coerceValue(signal.type, value);
    this.overrides.set(key, coerced);
    return coerced;
  }

  clearOverrides() {
    if (this.mode === 'mock') {
      for (const signal of this.scenario?.outputs ?? []) {
        this.overrides.set(signal.key, defaultValue(signal.type));
      }
    } else {
      this.overrides.clear();
    }
  }

  runCommand(name, args) {
    if (!this.model?.command) return null;
    const result = this.model.command(name, args, this.params);
    if (result) this.log('info', result);
    return result;
  }

  resetModel() {
    this.model?.reset(this.params);
    this.tick = 0;
    this.log('info', '模擬狀態已重置');
  }

  setMode(mode) {
    if (mode !== 'ads' && mode !== 'mock') throw new Error(`未知的模式:${mode}`);
    this.mode = mode;
    this.clearOverrides();
    this.log('info', mode === 'mock' ? '已切換為手動模擬模式(不連 PLC)' : '已切換為 ADS 模式');
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = process.hrtime.bigint();
    this.schedule();
    this.log('info', `模擬引擎啟動(週期 ${this.cycleTime} ms)`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.log('info', '模擬引擎已停止');
  }

  schedule() {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.cycle().catch((err) => {
        this.stats.errors++;
        this.stats.lastError = err?.message ?? String(err);
        this.log('error', `模擬週期錯誤:${this.stats.lastError}`);
      });
    }, this.cycleTime);
  }

  async cycle() {
    if (!this.running || !this.model || !this.scenario) {
      this.schedule();
      return;
    }

    const cycleStart = process.hrtime.bigint();
    // 用實際經過的時間積分,週期抖動就不會讓物理跑掉;上限 0.25s 避免暫停後大跳一步
    const dt = Math.min(0.25, Number(cycleStart - this.lastTime) / 1e9);
    this.lastTime = cycleStart;

    // --- 1. 取得致動器命令 ---
    let outputs;
    const adsStart = process.hrtime.bigint();
    if (this.mode === 'ads' && this.bridge.connected) {
      try {
        outputs = await this.bridge.readOutputs();
      } catch (err) {
        this.stats.errors++;
        this.stats.lastError = `讀取失敗:${err?.message ?? err}`;
        outputs = { ...this.outputs }; // 讀失敗就沿用上一輪,物理不中斷
      }
    } else {
      outputs = Object.fromEntries(this.scenario.outputs.map((s) => [s.key, defaultValue(s.type)]));
    }
    // 手動覆寫優先於 PLC 的值
    for (const [key, value] of this.overrides) outputs[key] = value;
    this.outputs = outputs;

    // --- 2. 推進物理 ---
    const { inputs, view } = this.model.step(dt, outputs, this.params);
    this.inputs = inputs;
    this.view = view;
    this.tick++;

    // --- 3. 回寫感測器 ---
    if (this.mode === 'ads' && this.bridge.connected) {
      try {
        this.stats.writes = await this.bridge.writeInputs(inputs);
      } catch (err) {
        this.stats.errors++;
        this.stats.lastError = `寫入失敗:${err?.message ?? err}`;
      }
    }
    this.stats.adsMs = Number(process.hrtime.bigint() - adsStart) / 1e6;
    this.stats.cycleMs = Number(process.hrtime.bigint() - cycleStart) / 1e6;

    this.emit('tick', this.state);
    this.schedule();
  }
}

export { scenarios };
export default SimEngine;
