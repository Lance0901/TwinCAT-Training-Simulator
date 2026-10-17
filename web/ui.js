import { isCompatible, typeAffinity, isBuiltinSymbol } from '../shared/types.js';

/**
 * DOM 渲染層。
 *
 * 狀態每 50ms 更新一次,所以這裡刻意分成 build / update 兩階段:
 * 切換場景時才重建 DOM,之後只改既有節點的內容,避免每幀重繪整個側欄。
 */

/** 名字看起來像警報的訊號,亮燈時用紅色而不是綠色 */
const ALARM_PATTERN = /ng|alarm|overtemp|dryrun|highhigh|lowlow|limit/i;

function isAlarmSignal(signal) {
  return ALARM_PATTERN.test(signal.key);
}

function formatNumber(value, type) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (type === 'REAL' || type === 'LREAL') {
    return Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(1);
  }
  return String(Math.round(value));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 致動器 / 感測器共用的訊號列表 */
export class IoPanel {
  /**
   * @param {HTMLElement} container
   * @param {'output'|'input'} kind output 可操作,input 唯讀
   * @param {{onOverride:(key:string, value:any)=>void}} handlers
   */
  constructor(container, kind, handlers = {}) {
    this.container = container;
    this.kind = kind;
    this.handlers = handlers;
    this.rows = new Map();
    this.editable = false;
  }

  build(signals, { editable = false } = {}) {
    this.container.innerHTML = '';
    this.rows.clear();
    this.editable = editable;

    for (const signal of signals) {
      const row = el('div', 'io-row');

      const label = el('div', 'io-label');
      label.append(el('span', 'name', signal.label));
      label.append(el('span', 'tag', signal.tag));
      row.append(label);

      const valueBox = el('div', 'io-value');
      const entry = { signal, row, valueBox };

      if (signal.type === 'BOOL') {
        if (editable) {
          const toggle = el('button', 'toggle');
          toggle.type = 'button';
          toggle.addEventListener('click', () => {
            this.handlers.onOverride?.(signal.key, !entry.lastValue);
          });
          valueBox.append(toggle);
          entry.control = toggle;
        } else {
          const lamp = el('span', `lamp${isAlarmSignal(signal) ? ' alarm' : ''}`);
          valueBox.append(lamp);
          entry.control = lamp;
        }
      } else if (editable) {
        const input = el('input', 'num-input');
        input.type = 'number';
        input.step = 'any';
        input.addEventListener('change', () => {
          this.handlers.onOverride?.(signal.key, Number(input.value));
        });
        valueBox.append(input);
        entry.control = input;
      } else {
        const num = el('span', 'io-num', '—');
        valueBox.append(num);
        entry.control = num;
      }

      if (signal.unit) valueBox.append(el('span', 'io-unit', signal.unit));

      // 覆寫指示 / 解除鈕:只有 ADS 模式下的致動器才需要
      if (editable) {
        const pin = el('button', 'pin', '○');
        pin.type = 'button';
        pin.title = '手動覆寫中,點擊交還給 PLC 控制';
        pin.addEventListener('click', () => this.handlers.onOverride?.(signal.key, null));
        valueBox.append(pin);
        entry.pin = pin;
      }

      row.append(valueBox);
      this.container.append(row);
      this.rows.set(signal.key, entry);
    }
  }

  /**
   * @param {Record<string, any>} values
   * @param {Record<string, any>} overrides 目前被手動覆寫的訊號
   * @param {boolean} showPins mock 模式下所有值本來就是手動的,不需要顯示覆寫標記
   */
  update(values, overrides = {}, showPins = true) {
    for (const [key, entry] of this.rows) {
      const value = values?.[key];
      if (value === undefined) continue;
      entry.lastValue = value;

      if (entry.signal.type === 'BOOL') {
        entry.control.classList.toggle('on', Boolean(value));
      } else if (entry.control.tagName === 'INPUT') {
        // 使用者正在輸入時不要蓋掉他打到一半的內容
        if (document.activeElement !== entry.control) {
          entry.control.value = formatNumber(value, entry.signal.type);
        }
      } else {
        entry.control.textContent = formatNumber(value, entry.signal.type);
      }

      if (entry.pin) {
        const overridden = showPins && key in overrides;
        entry.pin.classList.toggle('active', overridden);
        entry.pin.textContent = overridden ? '●' : '○';
        entry.pin.style.visibility = showPins ? 'visible' : 'hidden';
        entry.row.classList.toggle('overridden', overridden);
      }
    }
  }
}

/** 物理參數滑桿 */
export class ParamPanel {
  constructor(container, onChange) {
    this.container = container;
    this.onChange = onChange;
    this.rows = new Map();
  }

  build(params, values) {
    this.container.innerHTML = '';
    this.rows.clear();

    for (const def of params) {
      const row = el('div', `param-row${def.numeric ? ' param-numeric' : ''}`);
      const label = el('label');
      label.append(el('span', null, `${def.label}${def.unit ? ` (${def.unit})` : ''}`));

      // numeric 參數要求「跟設備規格一模一樣的數字」(編碼器 1048576 之類),
      // 拖滑桿對不準,直接給輸入框。
      if (def.numeric) {
        row.append(label);
        const input = el('input', 'num-input');
        input.type = 'number';
        input.min = def.min;
        input.max = def.max;
        input.step = def.step;
        input.value = values[def.key] ?? def.default;
        input.addEventListener('change', () => this.onChange?.(def.key, Number(input.value)));
        row.append(input);
        this.container.append(row);
        this.rows.set(def.key, { input });
        continue;
      }

      const val = el('span', 'val', String(values[def.key] ?? def.default));
      label.append(val);
      row.append(label);

      const slider = el('input');
      slider.type = 'range';
      slider.min = def.min;
      slider.max = def.max;
      slider.step = def.step;
      slider.value = values[def.key] ?? def.default;
      slider.addEventListener('input', () => {
        val.textContent = slider.value;
        this.onChange?.(def.key, Number(slider.value));
      });
      row.append(slider);

      this.container.append(row);
      this.rows.set(def.key, { slider, val });
    }
  }

  /** 伺服器夾住的值可能與畫面不同,同步回來(但別打斷正在操作的控制項) */
  sync(values) {
    for (const [key, entry] of this.rows) {
      const v = values?.[key];
      if (v === undefined) continue;
      const control = entry.input ?? entry.slider;
      if (document.activeElement === control) continue;
      if (Number(control.value) !== v) {
        control.value = v;
        if (entry.val) entry.val.textContent = String(v);
      }
    }
  }
}

/**
 * 機台 I/O 表。
 *
 * 站在一台實體機台前面,工程師要先搞懂兩件事:「我會收到哪些訊號」和
 * 「我能控制哪些訊號」。所以這裡以 PLC 的視角分成 INPUT / OUTPUT 兩區,
 * 每個訊號都附上觸發條件與範圍,再帶著即時值 —— 看規格的同時就能對照
 * 現在的狀態,不必在兩個畫面之間切換。
 *
 * 接線欄用 `<input list>` + `<datalist>`,同一個欄位既能從 PLC 變數清單挑,
 * 也能手動打完整路徑 —— PLC 還沒下載程式時只剩手動輸入這條路。
 * datalist 依型別分組,BOOL 訊號就只會看到 PLC 裡的 BOOL 變數。
 */
export class MappingPanel {
  constructor(container, dropdownHost, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.rows = new Map();
    this.symbols = [];
    this.options = [];
    this.activeIndex = -1;
    this.openEntry = null;

    // 自製下拉而不是用 <datalist>:datalist 只顯示「符合已輸入內容」的選項,
    // 欄位裡本來就有預設路徑,一比對就全被濾掉,看起來像沒東西可選。
    //
    // dropdownHost 要傳 <dialog> 本身:showModal() 會把 dialog 推進 top layer,
    // 掛在 body 或其他地方的元素不管 z-index 多高都會被它蓋住。
    this.dropdown = el('ul', 'combo-list');
    this.dropdown.hidden = true;
    (dropdownHost ?? document.body).append(this.dropdown);

    window.addEventListener('resize', () => this.closeDropdown());
    // 對話框內捲動時清單會跟不上,直接關掉
    this.container.addEventListener('scroll', () => this.closeDropdown(), true);
  }

  build(scenario, mapping = {}) {
    this.container.innerHTML = '';
    this.rows.clear();

    const sections = [
      {
        dir: 'IN',
        title: '輸入訊號 — 這台機器會回報給你什麼',
        note: '模擬器寫入、PLC 只能讀。在 PLC 程式裡對這些變數賦值沒有意義,每個週期都會被覆蓋。',
        signals: scenario.inputs,
      },
      {
        dir: 'OUT',
        title: '輸出訊號 — 你能控制這台機器什麼',
        note: 'PLC 寫入、模擬器讀取。這些就是你的程式實際能下的命令。',
        signals: scenario.outputs,
      },
    ];

    for (const section of sections) {
      const head = el('div', `mapping-section ${section.dir === 'IN' ? 'sec-in' : 'sec-out'}`);
      const title = el('div', 'mapping-section-title');
      title.append(el('span', `dir-badge ${section.dir === 'IN' ? 'in' : 'out'}`, section.dir));
      title.append(el('h3', null, section.title));
      title.append(el('span', 'mapping-count', `${section.signals.length} 點`));
      head.append(title);
      head.append(el('p', 'mapping-section-note', section.note));
      this.container.append(head);

      for (const signal of section.signals) {
        const row = el('div', 'mapping-row');

        // 第一行:名稱、型別、即時值
        const nameLine = el('div', 'mapping-name');
        nameLine.append(el('span', 'sig-name', signal.label));
        nameLine.append(el('span', 'type-badge', signal.type));
        if (signal.unit) nameLine.append(el('span', 'unit-badge', signal.unit));
        nameLine.append(el('span', 'spacer'));

        const live = el('span', 'live-value');
        if (signal.type === 'BOOL') {
          live.append(el('span', 'lamp'));
        } else {
          live.append(el('span', 'live-num', '—'));
        }
        nameLine.append(live);
        row.append(nameLine);

        // 第二行:觸發條件 / 範圍說明
        if (signal.desc) row.append(el('p', 'mapping-desc', signal.desc));

        // 第三行:接到哪個 PLC 變數
        const wire = el('div', 'mapping-wire');
        wire.append(el('label', 'wire-label', '接到 PLC 變數'));

        const input = el('input', 'mapping-input');
        input.type = 'text';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.placeholder = `${scenario.namespace}.${signal.tag}`;
        input.value = mapping[signal.key] ?? '';
        wire.append(input);

        const entry = { signal, row, input };

        // 點一下就列出所有相容變數,不必先刪掉欄位裡的字。
        // 同時全選內容,直接打字就是取代而不是插在中間。
        input.addEventListener('focus', () => {
          input.select();
          this.openDropdown(entry);
        });
        input.addEventListener('click', () => this.openDropdown(entry));
        // 打字之後才開始過濾
        input.addEventListener('input', () => {
          this.filterActive = true;
          if (this.openEntry === entry) this.renderOptions(entry);
          else this.openDropdown(entry, { filter: true });
        });
        input.addEventListener('blur', () => {
          if (this.openEntry === entry) this.closeDropdown();
        });
        input.addEventListener('keydown', (ev) => this.onKeyDown(ev, entry));
        input.addEventListener('change', () => this.handlers.onChange?.(signal.key, input.value));

        const caret = el('button', 'combo-caret', '▾');
        caret.type = 'button';
        caret.tabIndex = -1;
        caret.title = '列出 PLC 中型別相容的變數';
        caret.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          if (this.openEntry === entry) this.closeDropdown();
          else {
            input.focus();
            this.openDropdown(entry);
          }
        });
        wire.append(caret);

        const bind = el('span', 'bind idle', '○');
        wire.append(bind);
        row.append(wire);

        this.container.append(row);
        entry.bind = bind;
        entry.live = live.firstChild;
        this.rows.set(signal.key, entry);
      }
    }

  }

  onKeyDown(ev, entry) {
    if (ev.key === 'Escape') {
      this.closeDropdown();
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (this.dropdown.hidden) {
        this.openDropdown(entry);
        return;
      }
      if (!this.options.length) return;
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      const next = (this.activeIndex + step + this.options.length) % this.options.length;
      this.highlight(next);
      return;
    }
    if (ev.key === 'Enter' && !this.dropdown.hidden && this.activeIndex >= 0) {
      ev.preventDefault();
      this.choose(entry, this.options[this.activeIndex].name);
    }
  }

  /**
   * 取得某個訊號型別可用的 PLC 變數,同型別排前面。
   *
   * 不是只找完全相同的型別:真實專案的位置常常宣告成 LREAL、計數宣告成 UDINT,
   * 只列完全相同的話清單十之八九是空的(實測過的 PLC 有 113 個 LREAL、0 個 REAL)。
   */
  candidatesFor(type) {
    return this.symbols
      .filter((s) => isCompatible(type, s.type))
      .sort((a, b) => {
        // 先比型別貼近程度(REAL 訊號要先看到 LREAL,而不是一堆 BYTE 常數),
        // 再讓使用者自己的變數排在 TwinCAT 內建函式庫之前
        const affinity = typeAffinity(type, a.type) - typeAffinity(type, b.type);
        if (affinity !== 0) return affinity;
        const builtin = Number(isBuiltinSymbol(a.name)) - Number(isBuiltinSymbol(b.name));
        if (builtin !== 0) return builtin;
        return a.name.localeCompare(b.name);
      });
  }

  setSymbols(symbols) {
    this.symbols = symbols ?? [];
    // 重讀符號代表 PLC 可能換過程式,樹也要跟著重建
    this.tree = null;
    this.treeError = null;
    if (this.openEntry) this.renderOptions(this.openEntry);
  }

  /**
   * 畫出候選清單。有兩種模式:
   *
   *  - 打字時 → 扁平搜尋(只搜可直接綁的純量符號)
   *  - 沒打字 → 樹狀瀏覽,跟 TwinCAT 的 Target Browser 一樣可以一層層展開
   *
   * 樹是必要的:NC 軸的回授全在 `AxisX.NcToPlc.ActPos` 這種路徑裡,
   * 而 getSymbols() 只給頂層符號,不展開就永遠選不到。
   */
  renderOptions(entry) {
    const query = this.filterActive ? entry.input.value.trim().toLowerCase() : '';
    this.dropdown.innerHTML = '';
    this.activeIndex = -1;
    this.options = [];

    if (query) this.renderSearch(entry, query);
    else this.renderTree(entry);
  }

  renderSearch(entry, query) {
    const matched = this.candidatesFor(entry.signal.type).filter((s) =>
      s.name.toLowerCase().includes(query),
    );
    this.options = matched.slice(0, 200);

    if (!this.symbols.length) {
      this.dropdown.append(el('li', 'combo-empty', '尚未讀取 PLC 變數清單 —— 請先按上方的「讀取 PLC 變數清單」'));
      return;
    }
    if (!matched.length) {
      this.dropdown.append(
        el('li', 'combo-empty', `沒有名稱含「${entry.input.value}」且型別相容於 ${entry.signal.type} 的變數。清空欄位可改用樹狀瀏覽。`),
      );
      return;
    }

    this.options.forEach((symbol, i) => {
      this.dropdown.append(this.makeItem(entry, symbol.name, symbol.name, symbol.type, symbol.comment, 0, i));
    });
    if (matched.length > this.options.length) {
      this.dropdown.append(
        el('li', 'combo-empty', `另有 ${matched.length - this.options.length} 個相符,繼續輸入以縮小範圍`),
      );
    }
  }

  renderTree(entry) {
    if (!this.tree) {
      this.dropdown.append(el('li', 'combo-empty', '正在載入 PLC 變數樹…'));
      this.loadTreeRoot();
      return;
    }
    if (this.treeError) {
      this.dropdown.append(el('li', 'combo-empty', this.treeError));
      return;
    }

    const visible = [];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        visible.push({ node: n, depth });
        if (n.expanded && n.children) walk(n.children, depth + 1);
      }
    };
    walk(this.tree, 0);

    const head = el('li', 'combo-empty combo-hint', '點 ▸ 展開結構,點變數名選取。直接打字可改用搜尋。');
    this.dropdown.append(head);

    for (const { node, depth } of visible) {
      const selectable = node.path && isCompatible(entry.signal.type, node.type);
      const li = this.makeItem(
        entry,
        node.path,
        node.name,
        node.type,
        node.comment,
        depth,
        selectable ? this.options.length : -1,
        node,
      );
      if (selectable) this.options.push({ name: node.path, type: node.type });
      this.dropdown.append(li);
    }
  }

  /** 產生一列。index >= 0 代表可用鍵盤選取 */
  makeItem(entry, path, label, type, comment, depth, index, node) {
    const li = el('li', 'combo-item');
    li.style.paddingLeft = `${9 + depth * 14}px`;

    if (node?.expandable) {
      const twisty = el('span', 'c-twisty', node.expanded ? '▾' : '▸');
      twisty.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.toggleNode(entry, node);
      });
      li.append(twisty);
    } else {
      li.append(el('span', 'c-twisty c-twisty-empty', ''));
    }

    li.append(el('span', 'c-name', label));

    if (type) {
      const t = el('span', 'c-type', type);
      if (type !== entry.signal.type) t.classList.add('c-type-diff');
      li.append(t);
    }
    if (comment) li.append(el('span', 'c-comment', comment));

    const selectable = index >= 0;
    if (!selectable) li.classList.add('combo-item-dim');
    else {
      li.addEventListener('mouseenter', () => this.highlight(index));
    }

    // 用 mousedown:blur 會先於 click,清單來不及被點到
    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      if (selectable) this.choose(entry, path);
      else if (node?.expandable) this.toggleNode(entry, node);
    });

    return li;
  }

  async loadTreeRoot() {
    if (this.treeLoading) return;
    this.treeLoading = true;
    try {
      const children = await this.handlers.onBrowse?.('');
      this.tree = groupByNamespace(children ?? []);
      this.treeError = null;
    } catch (err) {
      this.tree = [];
      this.treeError = `載入變數樹失敗:${err?.message ?? err}`;
    }
    this.treeLoading = false;
    if (this.openEntry) this.renderOptions(this.openEntry);
  }

  async toggleNode(entry, node) {
    if (node.expanded) {
      node.expanded = false;
      this.renderOptions(entry);
      return;
    }
    if (!node.children) {
      node.children = [{ name: '載入中…', type: '', path: '', expandable: false }];
      node.expanded = true;
      this.renderOptions(entry);
      try {
        node.children = await this.handlers.onBrowse?.(node.path);
      } catch (err) {
        node.children = [{ name: `展開失敗:${err?.message ?? err}`, type: '', path: '', expandable: false }];
      }
    }
    node.expanded = true;
    this.renderOptions(entry);
  }

  highlight(index) {
    const items = [...this.dropdown.querySelectorAll('.combo-item')];
    items.forEach((li, i) => li.classList.toggle('active', i === index));
    this.activeIndex = index;
    items[index]?.scrollIntoView({ block: 'nearest' });
  }

  choose(entry, value) {
    entry.input.value = value;
    this.closeDropdown();
    this.handlers.onChange?.(entry.signal.key, value);
  }

  openDropdown(entry, { filter = false } = {}) {
    this.openEntry = entry;
    this.filterActive = filter;
    this.renderOptions(entry);
    // 清單用 fixed 定位:對話框內層有 overflow 捲動,absolute 會被裁掉
    const r = entry.input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    this.dropdown.style.left = `${r.left}px`;
    this.dropdown.style.width = `${r.width}px`;
    if (below < 220 && r.top > below) {
      this.dropdown.style.top = '';
      this.dropdown.style.bottom = `${window.innerHeight - r.top + 4}px`;
      this.dropdown.style.maxHeight = `${r.top - 12}px`;
    } else {
      this.dropdown.style.bottom = '';
      this.dropdown.style.top = `${r.bottom + 4}px`;
      this.dropdown.style.maxHeight = `${below - 12}px`;
    }
    this.dropdown.hidden = false;
  }

  closeDropdown() {
    this.dropdown.hidden = true;
    this.openEntry = null;
    this.activeIndex = -1;
  }

  update(mapping = {}, overrides = {}, bindStatus = {}, values = {}) {
    for (const [key, entry] of this.rows) {
      const path = mapping[key] ?? '';
      // 使用者正在打字時不要覆蓋輸入框
      if (document.activeElement !== entry.input && entry.input.value !== path) {
        entry.input.value = path;
      }

      entry.row.classList.toggle('changed', key in overrides);

      const status = bindStatus[key];
      const state = status?.ok ? 'ok' : status?.reason === '未連線' ? 'idle' : 'fail';
      // 綁上了但型別不同(REAL 訊號接到 LREAL 變數之類)標成黃色,提醒有轉換
      const converted = Boolean(status?.ok && status.note);
      entry.bind.className = `bind ${state}${converted ? ' converted' : ''}`;
      entry.bind.textContent = { ok: converted ? '≈' : '✓', idle: '○', fail: '✕' }[state];
      entry.bind.title = status?.ok
        ? status.note
          ? `已綁定,但${status.note}`
          : `已綁定${status.plcType ? `(PLC 型別 ${status.plcType})` : ''}`
        : (status?.reason ?? '未綁定');

      const value = values[key];
      if (value === undefined) continue;
      if (entry.signal.type === 'BOOL') {
        entry.live.classList.toggle('on', Boolean(value));
        entry.live.classList.toggle('alarm', isAlarmSignal(entry.signal));
      } else {
        entry.live.textContent = formatNumber(value, entry.signal.type);
      }
    }
  }
}

/**
 * 把頂層符號依命名空間(第一個點之前)分組。
 *
 * TwinCAT 的 GVL 本身不是符號 —— 符號清單裡只有 `GVL_Xts.aMoverAxis`,
 * 沒有 `GVL_Xts`。少了這層,幾百個頂層符號會平鋪成一長串,
 * 跟 Target Browser 的樣子差很多。這裡補上虛擬的命名空間節點。
 */
function groupByNamespace(nodes) {
  const groups = new Map();
  const loose = [];

  for (const n of nodes) {
    const dot = n.path.indexOf('.');
    if (dot <= 0) {
      loose.push(n);
      continue;
    }
    const ns = n.path.slice(0, dot);
    if (!groups.has(ns)) groups.set(ns, []);
    // 群組內只顯示命名空間之後的部分,免得每一列都重複前綴
    groups.get(ns).push({ ...n, name: n.path.slice(dot + 1) });
  }

  const result = [...groups.entries()]
    .map(([ns, children]) => ({
      // path 留空 = 這是虛擬節點,不能選,只能展開
      path: '',
      name: ns,
      type: '',
      comment: '',
      expandable: true,
      expanded: false,
      children: dropNestedDuplicates(children),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...result, ...loose];
}

/**
 * 丟掉「祖先也在同一份清單裡」的項目。
 *
 * TwinCAT 會把部分巢狀路徑一起當成頂層符號公開,於是 `aMoverAxis` 和
 * `aMoverAxis[1].NcToPlc` 會並排出現。後者展開前者就到得了,平鋪在同一層
 * 只是把清單撐長。
 */
function dropNestedDuplicates(nodes) {
  const names = new Set(nodes.map((n) => n.name));
  return nodes
    .filter((n) => {
      for (let i = 1; i < n.name.length; i++) {
        const ch = n.name[i];
        if ((ch === '.' || ch === '[') && names.has(n.name.slice(0, i))) return false;
      }
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 格位編號 → 座標,與模型端同一套規則 */
function gridPoint(grid, index) {
  return {
    x: grid.x0 + (index % grid.cols) * grid.dx,
    y: grid.y0 + Math.floor(index / grid.cols) * grid.dy,
  };
}

/**
 * 把場景幾何裡的格位攤成座標表。
 *
 * 學員寫 PLC 程式時要的就是這些數字 —— 與其讓他們從畫面上目測,
 * 不如直接把表列出來,還能一鍵複製成 ST 陣列宣告貼進專案。
 */
export function buildCoordTables(scenario) {
  const g = scenario.geometry ?? {};
  const tables = [];

  const addGrid = (grid, title, varName, note) => {
    if (!grid) return;
    const count = grid.cols * grid.rows;
    tables.push({
      title,
      varName,
      note,
      points: Array.from({ length: count }, (_, i) => ({ index: i, ...gridPoint(grid, i) })),
    });
  };

  addGrid(g.pickGrid, '取料盤格位', 'PickPos', '一格一格取:第 0 格取完才換第 1 格。iNextPickIndex 會告訴你現在該去哪一格。');
  addGrid(g.placeGrid, '放料盤格位', 'PlacePos', '放料時位置要落在格心 ' + (g.tolerance ?? 6) + ' mm 內,而且吸嘴必須在下限位才算成功。');

  return tables;
}

/** 產生可直接貼進 PLC 專案的 ST 陣列宣告 */
export function coordTablesToSt(tables) {
  const lines = ['// ==== 由模擬器的座標表產生 ===='];
  for (const t of tables) {
    const n = t.points.length - 1;
    lines.push('');
    lines.push(`// ${t.title}(${t.points.length} 格)`);
    lines.push(
      `a${t.varName}X : ARRAY[0..${n}] OF REAL := [${t.points.map((p) => p.x).join(', ')}];`,
    );
    lines.push(
      `a${t.varName}Y : ARRAY[0..${n}] OF REAL := [${t.points.map((p) => p.y).join(', ')}];`,
    );
  }
  return lines.join('\n');
}

export function renderCoordTables(container, tables) {
  container.innerHTML = '';
  if (!tables.length) {
    container.append(el('p', 'panel-hint', '此場景沒有格位座標。'));
    return;
  }

  for (const t of tables) {
    const section = el('div', 'coord-section');
    const head = el('div', 'mapping-section-title');
    head.append(el('h3', null, t.title));
    head.append(el('span', 'mapping-count', `${t.points.length} 格`));
    section.append(head);
    if (t.note) section.append(el('p', 'mapping-section-note', t.note));

    const table = el('table', 'coord-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['格號', 'X (mm)', 'Y (mm)']) hr.append(el('th', null, h));
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    for (const p of t.points) {
      const tr = el('tr');
      tr.append(el('td', 'coord-index', String(p.index)));
      tr.append(el('td', null, String(p.x)));
      tr.append(el('td', null, String(p.y)));
      tbody.append(tr);
    }
    table.append(tbody);
    section.append(table);
    container.append(section);
  }
}

export function buildCommands(container, commands, onCommand) {
  container.innerHTML = '';
  if (!commands?.length) {
    container.append(el('p', 'panel-hint', '此場景沒有額外的手動操作。'));
    return;
  }
  for (const cmd of commands) {
    const btn = el('button', 'btn btn-sm', cmd.label);
    btn.type = 'button';
    btn.addEventListener('click', () => onCommand(cmd.key));
    container.append(btn);
  }
}

export function buildScenarioTabs(container, scenarios, activeId, onSelect) {
  container.innerHTML = '';
  for (const s of scenarios) {
    const btn = el('button', `scenario-tab${s.id === activeId ? ' active' : ''}`, s.name);
    btn.type = 'button';
    btn.title = s.description;
    btn.addEventListener('click', () => onSelect(s.id));
    container.append(btn);
  }
}

export function setActiveTab(container, activeId, scenarios) {
  [...container.children].forEach((child, i) => {
    child.classList.toggle('active', scenarios[i]?.id === activeId);
  });
}

/** 3D 視圖左上角的即時數值 */
export class Hud {
  constructor(container) {
    this.container = container;
    this.items = new Map();
  }

  set(items) {
    // items: [{ key, label, value, alarm }]
    const seen = new Set();
    for (const item of items) {
      seen.add(item.key);
      let node = this.items.get(item.key);
      if (!node) {
        node = el('div', 'hud-item');
        node.append(el('span', 'hud-label', item.label));
        node.append(el('span', 'hud-value', ''));
        this.container.append(node);
        this.items.set(item.key, node);
      }
      node.lastChild.textContent = item.value;
      node.classList.toggle('alarm', Boolean(item.alarm));
    }
    for (const [key, node] of this.items) {
      if (!seen.has(key)) {
        node.remove();
        this.items.delete(key);
      }
    }
  }

  clear() {
    this.container.innerHTML = '';
    this.items.clear();
  }
}

const MAX_LOG_LINES = 300;

export function appendLog(container, entry) {
  const li = el('li', entry.level);
  const time = new Date(entry.at ?? Date.now());
  const stamp = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(
    time.getSeconds(),
  ).padStart(2, '0')}`;
  li.append(el('span', 'time', stamp));
  li.append(document.createTextNode(entry.message));

  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 20;
  container.append(li);
  while (container.children.length > MAX_LOG_LINES) container.firstChild.remove();
  // 使用者往回捲看舊訊息時不要硬把他拉回底部
  if (atBottom) container.scrollTop = container.scrollHeight;
}

export function updateConnBadge(node, { wsConnected, mode, ads }) {
  const dotText = node.querySelector('.conn-text');
  node.classList.remove('online', 'offline', 'mock');

  if (!wsConnected) {
    node.classList.add('offline');
    dotText.textContent = '後端未連線';
    return;
  }
  if (mode === 'mock') {
    node.classList.add('mock');
    dotText.textContent = '手動模擬模式';
    return;
  }
  if (ads?.connected) {
    // 連上 ADS router ≠ 底下有 PLC 可用。runtime 沒下載程式時所有讀寫都會失敗,
    // 這時說「已連線」等於騙人,要明白講出卡在哪一段。
    if (!ads.plcReady) {
      node.classList.add('mock');
      // Config 模式和「沒下載程式」要分開講 —— 兩者要按的地方完全不同
      if (ads.tcSystemState === 'Config') {
        dotText.textContent = 'TwinCAT 在 Config 模式,需切到 Run Mode';
      } else if (ads.plcState) {
        dotText.textContent = `PLC Runtime 在 ${ads.plcState},不是 Run`;
      } else {
        dotText.textContent = 'ADS 已連線,但 PLC 沒有程式';
      }
      return;
    }
    const missing = ads.missingTags?.length;
    if (missing) {
      node.classList.add('mock');
      dotText.textContent = `PLC 已連線,${missing} 個符號未綁定`;
      return;
    }
    node.classList.add('online');
    dotText.textContent = `PLC 已連線 ${ads.settings?.targetAmsNetId ?? ''}:${ads.settings?.targetAdsPort ?? ''}`;
    return;
  }
  node.classList.add('offline');
  dotText.textContent = ads?.connecting ? 'ADS 連線中…' : 'ADS 未連線';
}
