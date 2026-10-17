import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './paths.js';

const CONFIG_FILE = path.join(CONFIG_DIR, 'session.json');

/**
 * 上次離開時的介面狀態。
 *
 * 只存「重開後不記得會讓人以為東西壞掉」的項目 —— 目前就是場景。
 * I/O 對映是按場景分開存的,如果重開後場景被重設回預設值,使用者看到的
 * 會是另一個場景的清單,很容易誤判成自己綁的東西全部消失了。
 *
 * 檔案格式:{ "scenarioId": "gantry" }
 */
export class SessionStore {
  constructor() {
    /** @type {{ scenarioId?: string }} */
    this.data = {};
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        this.data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) ?? {};
      }
    } catch (err) {
      console.warn(`[sim] 讀取上次的介面狀態失敗,改用預設值:${err.message}`);
      this.data = {};
    }
  }

  save() {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    } catch (err) {
      console.warn(`[sim] 儲存介面狀態失敗:${err.message}`);
    }
  }

  get scenarioId() {
    return this.data.scenarioId ?? null;
  }

  set scenarioId(id) {
    if (!id || this.data.scenarioId === id) return;
    this.data.scenarioId = id;
    this.save();
  }
}

export default SessionStore;
