import fs from 'node:fs';
import path from 'node:path';
import { tagPath } from '../shared/scenarios/index.js';
import { CONFIG_DIR } from './paths.js';

const CONFIG_FILE = path.join(CONFIG_DIR, 'io-mapping.json');

/**
 * I/O 對映儲存。
 *
 * 場景定義裡的 `namespace` + `tag` 只是「建議的」PLC 變數路徑。
 * 學員手上可能已經有既存專案、或習慣自己的命名,所以每個訊號都能單獨改接到
 * 任意 PLC 符號。這裡只存「與預設不同」的項目 —— 全部存下來的話,日後場景
 * 定義調整了,舊檔案會把過時的路徑硬蓋回去。
 *
 * 檔案格式:
 * {
 *   "conveyor": { "beltForward": "MAIN.bMotorFwd" },
 *   "tank": { "level": "GVL_Process.rTankLevel" }
 * }
 */
export class MappingStore {
  constructor() {
    /** @type {Record<string, Record<string, string>>} */
    this.overrides = {};
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        this.overrides = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      }
    } catch (err) {
      console.warn(`[sim] 讀取 I/O 對映失敗,改用預設值:${err.message}`);
      this.overrides = {};
    }
  }

  /**
   * 存檔失敗一定要讓使用者看見 —— 靜靜吞掉的話,綁完當下看起來一切正常,
   * 重開才發現全部不見,而且完全不知道是權限還是路徑的問題。
   * 拋出去會經由 WebSocket 顯示在網頁的訊息列。
   */
  save() {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(this.overrides, null, 2)}\n`, 'utf8');
    } catch (err) {
      throw new Error(
        `I/O 對映無法存檔,這次改的綁定重開後會消失:${err.message}(位置:${CONFIG_FILE})`,
      );
    }
  }

  /** 某個訊號實際要綁的 PLC 符號路徑 */
  resolve(scenario, signal) {
    return this.overrides[scenario.id]?.[signal.key] ?? tagPath(scenario, signal);
  }

  /** 整個場景的 { signalKey: 完整符號路徑 } */
  resolveAll(scenario) {
    const result = {};
    for (const signal of [...scenario.outputs, ...scenario.inputs]) {
      result[signal.key] = this.resolve(scenario, signal);
    }
    return result;
  }

  /** path 為空字串或 null 代表恢復預設 */
  set(scenario, signalKey, plcPath) {
    const signal = [...scenario.outputs, ...scenario.inputs].find((s) => s.key === signalKey);
    if (!signal) throw new Error(`場景「${scenario.id}」沒有訊號「${signalKey}」`);

    const trimmed = typeof plcPath === 'string' ? plcPath.trim() : '';
    const scenarioMap = this.overrides[scenario.id] ?? {};

    if (!trimmed || trimmed === tagPath(scenario, signal)) {
      delete scenarioMap[signalKey];
    } else {
      scenarioMap[signalKey] = trimmed;
    }

    if (Object.keys(scenarioMap).length) this.overrides[scenario.id] = scenarioMap;
    else delete this.overrides[scenario.id];

    this.save();
    return this.resolve(scenario, signal);
  }

  reset(scenario) {
    delete this.overrides[scenario.id];
    this.save();
  }

  /** 前端要知道哪些訊號被改過,才能標示出來 */
  overridesFor(scenario) {
    return { ...(this.overrides[scenario.id] ?? {}) };
  }

  /**
   * 丟掉已經不存在的場景與訊號。
   *
   * 場景定義會隨版本調整(例如龍門改成 NC 驅動之後拿掉了幾個訊號),
   * 舊檔案裡的孤兒項目留著不會生效,卻會在設定檔裡看起來還綁著。
   *
   * @returns 清掉的項目數
   */
  prune(scenarioList) {
    let removed = 0;

    for (const [scenarioId, signals] of Object.entries(this.overrides)) {
      const scenario = scenarioList.find((s) => s.id === scenarioId);
      if (!scenario) {
        removed += Object.keys(signals).length;
        delete this.overrides[scenarioId];
        continue;
      }

      const known = new Set([...scenario.outputs, ...scenario.inputs].map((s) => s.key));
      for (const key of Object.keys(signals)) {
        if (!known.has(key)) {
          delete signals[key];
          removed += 1;
        }
      }
      if (!Object.keys(signals).length) delete this.overrides[scenarioId];
    }

    if (removed) this.save();
    return removed;
  }
}

export default MappingStore;
