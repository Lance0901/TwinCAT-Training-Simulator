import { EventEmitter } from 'node:events';
import { Client } from 'ads-client';
import { decodeValue, encodeValue, sizeOf, defaultValue } from './ads-codec.js';
import { isCompatible, conversionNote } from '../shared/types.js';

/** 能直接讀寫的純量型別 —— 這些就是樹的葉節點,再往下沒有東西了 */
const SCALAR_TYPES = new Set([
  'BOOL',
  'BYTE',
  'USINT',
  'SINT',
  'WORD',
  'UINT',
  'INT',
  'DWORD',
  'UDINT',
  'DINT',
  'LWORD',
  'ULINT',
  'LINT',
  'REAL',
  'LREAL',
  'TIME',
  'LTIME',
  'DATE',
  'DATE_AND_TIME',
  'DT',
  'TOD',
  'TIME_OF_DAY',
]);

/**
 * 判斷這個型別還能不能往下展開。
 * 純量、字串、列舉當葉節點;結構與陣列可以再展。
 */
function isExpandableType(type) {
  const t = String(type ?? '').trim().toUpperCase();
  if (!t) return false;
  if (SCALAR_TYPES.has(t)) return false;
  if (t.startsWith('STRING') || t.startsWith('WSTRING')) return false;
  if (t.startsWith('POINTER TO') || t.startsWith('REFERENCE TO')) return false;
  return true;
}

/**
 * ads-client 的錯誤訊息是英文技術訊息,對學員沒有指引性。
 * 把最常見的幾種翻成「該怎麼辦」的說法,其餘原樣帶出。
 */
function friendlyAdsError(err) {
  const msg = err?.message ?? String(err);
  if (/Reading symbol for/i.test(msg)) return '在 PLC 中找不到這個變數';
  if (/upload info/i.test(msg)) return 'PLC Runtime 尚未下載任何程式,請先在 TwinCAT 下載並執行 PLC 專案';
  if (/timeout/i.test(msg)) return 'ADS 逾時,請確認 PLC 是否處於 Run 狀態';
  return msg;
}

/**
 * ads-client 的警告同樣是英文。最常見的那一句講的是「連上了但沒有 PLC」,
 * 而這正是學員最容易誤判成「連不上」的狀況,一定要翻。
 */
function friendlyAdsWarning(msg) {
  const s = String(msg ?? '');
  if (/allowHalfOpen/i.test(s)) {
    return /config/i.test(s)
      ? 'TwinCAT 連上了,但系統處於 Config 模式,底下沒有 PLC runtime 可以讀寫'
      : 'TwinCAT 連上了,但 PLC runtime 還沒準備好';
  }
  return s;
}

/**
 * TwinCAT ADS 橋接層。
 *
 * 只做三件事:維持連線、把場景訊號綁到 PLC 符號、每個週期做一次批次讀 + 一次批次寫。
 * 用 readRawMulti / writeRawMulti 而非逐一 readValue,是因為模擬迴圈每 50ms 就要
 * 處理數十個訊號 — 批次可以把 N 次 ADS 往返壓成 1 次。
 */
export class AdsBridge extends EventEmitter {
  constructor() {
    super();
    /** @type {Client | null} */
    this.client = null;
    this.connected = false;
    this.connecting = false;
    this.lastError = null;
    this.settings = null;
    this.plcState = null;
    /** TwinCAT 系統本身的狀態(Config / Run)—— 和 PLC runtime 是兩回事 */
    this.tcSystemState = null;

    /** 目前綁定的場景 */
    this.scenario = null;
    /** 目前使用的 { signalKey: PLC 符號路徑 } */
    this.pathMap = {};
    /** key → { signal, symbol } */
    this.outputBindings = new Map();
    this.inputBindings = new Map();
    /**
     * 每個訊號的綁定結果,I/O 對映頁面靠它顯示成功/失敗與原因。
     * key → { path, ok, reason, plcType }
     */
    this.bindStatus = {};

    /** 上一次寫入 PLC 的值,值沒變就不重複寫 */
    this.lastWritten = new Map();
  }

  get status() {
    return {
      connected: this.connected,
      connecting: this.connecting,
      error: this.lastError,
      settings: this.settings,
      plcState: this.plcState,
      tcSystemState: this.tcSystemState,
      // 連上 ADS router 不等於底下有 PLC 可用。allowHalfOpen 讓我們在 runtime
      // 還沒下載程式時也能先連著等,但 UI 必須把這兩件事分開講,
      // 不然畫面顯示「已連線」、實際上一個變數都讀不到,只會讓人更困惑。
      plcReady: this.plcState === 'Run',
      boundScenario: this.scenario?.id ?? null,
      boundOutputs: this.outputBindings.size,
      boundInputs: this.inputBindings.size,
      bindStatus: this.bindStatus,
      missingTags: Object.values(this.bindStatus)
        .filter((s) => !s.ok)
        .map((s) => `${s.path}(${s.reason})`),
    };
  }

  log(level, message) {
    this.emit('log', { level, message });
  }

  async connect(settings) {
    if (this.connecting) throw new Error('連線程序進行中,請稍候');
    await this.disconnect();

    this.settings = { ...settings };
    this.connecting = true;
    this.lastError = null;
    this.emit('status', this.status);

    const clientSettings = {
      targetAmsNetId: settings.targetAmsNetId,
      targetAdsPort: settings.targetAdsPort,
      hideConsoleWarnings: true,
      // PLC 尚未下載程式或處於 Config 模式時仍允許連上,方便學員先開模擬器再下載程式
      allowHalfOpen: true,
      // TwinCAT 根本沒開的時候,預設逾時要等太久才知道失敗
      timeoutDelay: 3000,
    };
    // ads-client 會直接展開傳入的設定物件,帶著 undefined 的鍵會蓋掉它自己的預設值
    // 並在連線時炸掉,所以只有真的有值才加進去
    if (settings.routerAddress) clientSettings.routerAddress = settings.routerAddress;
    if (settings.routerTcpPort) clientSettings.routerTcpPort = settings.routerTcpPort;

    const client = new Client(clientSettings);

    client.on('warning', (msg) => this.log('warn', friendlyAdsWarning(msg)));
    client.on('connectionLost', () => {
      this.connected = false;
      this.log('error', 'ADS 連線中斷,ads-client 會自動嘗試重連');
      this.emit('status', this.status);
    });
    client.on('reconnect', () => {
      this.connected = true;
      this.log('info', 'ADS 已重新連線,重新綁定符號');
      this.emit('status', this.status);
      this.rebind();
    });
    client.on('disconnect', () => {
      this.connected = false;
      this.emit('status', this.status);
    });
    client.on('plcRuntimeStateChange', (state) => {
      this.plcState = state?.adsStateStr ?? null;
      this.log('info', `PLC Runtime 狀態:${this.plcState}`);
      this.emit('status', this.status);
    });
    // 重新下載 PLC 程式後所有 indexOffset 都會位移,必須重新解析符號
    client.on('plcSymbolVersionChange', () => {
      this.log('warn', 'PLC 符號版本變更(程式已重新下載),重新綁定符號');
      this.rebind();
    });

    this.client = client;

    try {
      const conn = await client.connect();
      this.connected = true;
      this.connecting = false;
      this.log(
        'info',
        `已連上 TwinCAT:${conn.targetAmsNetId}:${conn.targetAdsPort}(本機 ${conn.localAmsNetId}:${conn.localAdsPort})`,
      );
      await this.refreshStates();
      this.explainNotReady();
      if (this.scenario) await this.bind(this.scenario);
      this.startPlcWatch();
      this.emit('status', this.status);
      return this.status;
    } catch (err) {
      this.connecting = false;
      this.connected = false;
      this.lastError = err?.message ?? String(err);
      this.client = null;
      try {
        await client.disconnect(true);
      } catch {
        /* 連線失敗時的清理錯誤沒有意義,忽略 */
      }
      this.log('error', `ADS 連線失敗:${this.lastError}`);
      this.emit('status', this.status);
      throw err;
    }
  }

  /**
   * 更新兩個狀態。它們是分開的:TwinCAT 系統可能在 Run,但 PLC 沒下載程式;
   * 系統在 Config 時則不管下載過什麼都讀不到。
   */
  async refreshStates() {
    if (!this.client || !this.connected) return;
    try {
      const sys = await this.client.readTcSystemState();
      this.tcSystemState = sys?.adsStateStr ?? null;
    } catch {
      this.tcSystemState = null;
    }
    try {
      const plc = await this.client.readPlcRuntimeState();
      this.plcState = plc?.adsStateStr ?? null;
    } catch {
      this.plcState = null; // 沒有 runtime 時讀不到很正常
    }
  }

  /**
   * 連上了卻讀不到變數是學員最容易卡住的地方 —— 畫面顯示已連線,
   * 但每個訊號都綁不上,很自然就會回報成「連不上」。
   * 這裡把兩種原因分開講,並直接寫出在 TwinCAT 要按哪裡。
   */
  explainNotReady() {
    if (this.tcSystemState === 'Config') {
      this.log(
        'warn',
        'TwinCAT 目前是 Config 模式,底下沒有 PLC 可以讀寫 —— ' +
          '請在 TwinCAT 工具列按「Restart TwinCAT (Run Mode)」切到 Run 之後再試。',
      );
    } else if (this.plcState !== 'Run') {
      this.log(
        'warn',
        `PLC Runtime 還沒在跑(目前:${this.plcState ?? '沒有下載程式'})—— ` +
          '請在 TwinCAT 下載 PLC 專案並按 Start,模擬器會自動補綁。',
      );
    }
  }

  async disconnect() {
    const client = this.client;
    this.client = null;
    this.connected = false;
    this.connecting = false;
    this.plcState = null;
    this.tcSystemState = null;
    this.stopPlcWatch();
    this.clearBindings();
    if (client) {
      try {
        await client.disconnect();
      } catch {
        /* 已經斷線就算了 */
      }
      this.log('info', 'ADS 已中斷連線');
    }
    this.emit('status', this.status);
  }

  clearBindings() {
    this.outputBindings.clear();
    this.inputBindings.clear();
    this.lastWritten.clear();
    this.bindStatus = {};
  }

  /**
   * 把場景訊號綁到 PLC 符號。
   *
   * @param scenario 場景定義
   * @param pathMap  { signalKey: PLC 符號路徑 } —— 由 MappingStore 解析,
   *                 使用者在 I/O 對映頁面改過的訊號會指向自訂路徑
   *
   * 未連線時只記住場景與路徑,等連上再由 rebind() 補綁。
   */
  async bind(scenario, pathMap) {
    this.scenario = scenario;
    if (pathMap) this.pathMap = pathMap;
    this.clearBindings();

    const status = {};
    for (const signal of [...scenario.outputs, ...scenario.inputs]) {
      status[signal.key] = {
        path: this.pathMap[signal.key] ?? '',
        ok: false,
        reason: this.connected ? '尚未綁定' : '未連線',
      };
    }
    this.bindStatus = status;

    if (!this.client || !this.connected) {
      this.emit('status', this.status);
      return this.status;
    }

    const resolve = async (signal, target) => {
      const path = this.pathMap[signal.key];
      const entry = status[signal.key];
      if (!path) {
        entry.reason = '未指定 PLC 變數';
        return;
      }
      try {
        const symbol = await this.client.getSymbol(path);
        const plcType = String(symbol.type).toUpperCase();
        entry.plcType = symbol.type;

        // 場景定義的型別只是建議宣告。真實專案位置常常是 LREAL、計數是 UDINT,
        // 要求完全一致的話學員手上的變數一個都接不上,所以只看相容性。
        if (!isCompatible(signal.type, plcType)) {
          entry.reason = `型別不相容:PLC 為 ${symbol.type},這個訊號需要 ${signal.type}`;
          return;
        }

        // 編解碼一律依「PLC 那側的真實型別」—— 拿 REAL 的 codec 去讀 LREAL
        // 會抓到錯誤的 4 個位元組,那才是真正危險的事。
        let codecType = plcType;
        try {
          if (sizeOf(codecType) !== symbol.size) {
            entry.reason = `PLC 型別 ${symbol.type} 的大小(${symbol.size} B)與預期不符,無法安全存取`;
            return;
          }
        } catch {
          entry.reason = `不支援的 PLC 型別:${symbol.type}`;
          return;
        }

        target.set(signal.key, { signal, symbol, path, codecType });
        entry.ok = true;
        entry.reason = '';
        entry.note = conversionNote(signal.type, plcType);
      } catch (err) {
        entry.reason = friendlyAdsError(err);
      }
    };

    for (const signal of scenario.outputs) await resolve(signal, this.outputBindings);
    for (const signal of scenario.inputs) await resolve(signal, this.inputBindings);

    const failed = Object.values(status).filter((s) => !s.ok).length;
    if (failed) {
      this.log(
        'warn',
        `場景「${scenario.name}」有 ${failed} 個訊號無法綁定,可在「I/O 對映」頁面改接到正確的 PLC 變數`,
      );
    } else {
      this.log('info', `場景「${scenario.name}」符號綁定完成(${this.outputBindings.size} 讀 / ${this.inputBindings.size} 寫)`);
    }
    this.emit('status', this.status);
    return this.status;
  }

  rebind() {
    if (!this.scenario) return;
    this.bind(this.scenario).catch((err) => this.log('error', `重新綁定失敗:${err?.message ?? err}`));
  }

  /**
   * 定期看一下 PLC runtime 還在不在。
   *
   * 有兩種情況需要它:學員先開模擬器、之後才在 TwinCAT 下載程式;
   * 或是中途把 PLC 停掉再啟動。runtime 一上線就自動重新綁定符號,
   * 不必再回網頁按一次連線。
   */
  startPlcWatch() {
    this.stopPlcWatch();
    this.plcWatch = setInterval(async () => {
      if (!this.client || !this.connected) return;

      const wasPlc = this.plcState;
      const wasSys = this.tcSystemState;
      await this.refreshStates();
      if (this.plcState === wasPlc && this.tcSystemState === wasSys) return;

      const wasReady = wasPlc === 'Run';
      if (this.plcState === 'Run' && !wasReady) {
        this.log('info', 'PLC Runtime 已就緒,重新綁定符號');
        this.rebind();
      } else if (wasReady && this.plcState !== 'Run') {
        this.log('warn', `PLC Runtime 已離開 Run 狀態(目前:${this.plcState ?? '無程式'})`);
      } else if (this.tcSystemState !== wasSys) {
        this.log('info', `TwinCAT 系統狀態:${this.tcSystemState ?? '讀不到'}`);
      }
      this.emit('status', this.status);
    }, 3000);
    this.plcWatch.unref?.();
  }

  stopPlcWatch() {
    if (this.plcWatch) clearInterval(this.plcWatch);
    this.plcWatch = null;
  }

  /**
   * 瀏覽 PLC 的符號樹(給 I/O 對映頁面的樹狀選擇器用)。
   *
   * `getSymbols()` 只回傳頂層符號,不展開結構 —— 但 NC 軸的回授全藏在
   * `AxisX.NcToPlc.ActPos` 這種路徑裡,不展開根本選不到。
   * 這裡靠 `getDataType()` 一層一層展開,由前端點到哪展到哪:
   * XTS 這種專案光一個 AXIS_REF 就上百個成員,全展開會直接卡死。
   */
  async browseSymbol(path) {
    if (!this.client || !this.connected) throw new Error('尚未連上 TwinCAT');

    // 沒給路徑 = 要頂層符號。這裡不濾型別,結構也要留著才有得展開。
    if (!path) {
      let container;
      try {
        container = await this.client.getSymbols();
      } catch (err) {
        throw new Error(friendlyAdsError(err));
      }
      return Object.values(container)
        .map((s) => this.toNode(s.name, s.name, s.type, s.size, s.comment))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    let symbol;
    try {
      symbol = await this.client.getSymbol(path);
    } catch (err) {
      throw new Error(friendlyAdsError(err));
    }
    return this.expandType(path, symbol.type);
  }

  /** 把一個型別展開成子節點:陣列給索引、結構給成員 */
  async expandType(basePath, typeName) {
    let dt;
    try {
      dt = await this.client.getDataType(typeName);
    } catch (err) {
      throw new Error(friendlyAdsError(err));
    }

    // 陣列:每個索引一個節點。只處理第一維,多維陣列展開後再展下一維。
    if (dt.arrayInfos?.length) {
      const dim = dt.arrayInfos[0];
      const elemType = dt.type || dt.name;
      const nodes = [];
      // 上限保護:遇到超大陣列時不要一次吐幾千個節點出去
      const count = Math.min(dim.length, 512);
      for (let i = 0; i < count; i++) {
        const idx = dim.startIndex + i;
        nodes.push(this.toNode(`${basePath}[${idx}]`, `[${idx}]`, elemType, dt.size / dim.length, dt.comment));
      }
      if (dim.length > count) {
        nodes.push({ path: '', name: `… 還有 ${dim.length - count} 個元素`, type: '', info: true });
      }
      return nodes;
    }

    return (dt.subItems ?? []).map((item) =>
      this.toNode(`${basePath}.${item.name}`, item.name, item.type, item.size, item.comment),
    );
  }

  /** 建立樹節點,並判斷還能不能再往下展開 */
  toNode(path, name, type, size, comment) {
    return {
      path,
      name,
      type: type ?? '',
      size: size ?? 0,
      comment: comment ?? '',
      expandable: isExpandableType(type),
    };
  }

  /**
   * 讀回 PLC 所有符號,給 I/O 對映頁面當選單用。
   * 過濾掉系統與編譯器產生的內部符號 —— 學員不會想從三千筆裡面找。
   */
  async listSymbols() {
    if (!this.client || !this.connected) throw new Error('尚未連上 TwinCAT,無法讀取符號清單');

    let container;
    try {
      container = await this.client.getSymbols();
    } catch (err) {
      throw new Error(friendlyAdsError(err));
    }
    const supported = new Set(['BOOL', 'BYTE', 'USINT', 'SINT', 'WORD', 'UINT', 'INT', 'DWORD', 'UDINT', 'DINT', 'REAL', 'LREAL']);

    return Object.values(container)
      .filter((s) => {
        if (!supported.has(String(s.type).toUpperCase())) return false;
        if (s.arrayDimension > 0) return false;
        // TwinCAT 內部符號,對學員沒有意義
        return !/^(TwinCAT_SystemInfoVarList|Constants|Global_Version|__)/i.test(s.name);
      })
      .map((s) => ({
        name: s.name,
        type: String(s.type).toUpperCase(),
        size: s.size,
        comment: s.comment ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 批次讀 PLC 的致動器命令。回傳 { key: value },未綁定的訊號給型別預設值 */
  async readOutputs() {
    const result = {};
    for (const signal of this.scenario?.outputs ?? []) {
      result[signal.key] = defaultValue(signal.type);
    }
    if (!this.client || !this.connected || this.outputBindings.size === 0) return result;

    const entries = [...this.outputBindings.values()];
    const commands = entries.map((e) => ({
      indexGroup: e.symbol.indexGroup,
      indexOffset: e.symbol.indexOffset,
      size: e.symbol.size,
    }));

    const responses = await this.client.readRawMulti(commands);
    responses.forEach((res, i) => {
      if (res.success && res.value) {
        // 依 PLC 的實際型別解碼(可能是 LREAL 而非場景定義的 REAL)
        result[entries[i].signal.key] = decodeValue(entries[i].codecType, res.value);
      }
    });
    return result;
  }

  /** 批次寫回感測器回饋。只寫「值有變動」的訊號以降低 ADS 負載 */
  async writeInputs(values) {
    if (!this.client || !this.connected || this.inputBindings.size === 0) return 0;

    const commands = [];
    const keys = [];
    for (const [key, binding] of this.inputBindings) {
      if (!(key in values)) continue;
      const value = values[key];
      // REAL 每個週期都在微幅變動,四捨五入到合理精度以避免無謂的寫入
      const compare = typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
      if (this.lastWritten.get(key) === compare) continue;
      commands.push({
        indexGroup: binding.symbol.indexGroup,
        indexOffset: binding.symbol.indexOffset,
        // 同樣依 PLC 的實際型別編碼,長度才會對
        value: encodeValue(binding.codecType, value),
      });
      keys.push({ key, compare });
    }
    if (commands.length === 0) return 0;

    const responses = await this.client.writeRawMulti(commands);
    responses.forEach((res, i) => {
      // 只有寫成功才更新快取,否則下個週期會重試
      if (res.success) this.lastWritten.set(keys[i].key, keys[i].compare);
    });
    return commands.length;
  }
}

export default AdsBridge;
