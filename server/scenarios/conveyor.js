import def from '../../shared/scenarios/conveyor.js';

const G = def.geometry;

/** 一旦被氣缸推離皮帶中心超過這個距離,零件就掉入退料槽 */
const REJECT_FALL_DISTANCE = G.beltWidth / 2 + 40;

/** 反轉時零件退過皮帶起點這麼多就算掉出系統 */
const RETURN_MARGIN = 60;

export function createModel() {
  let parts = [];
  let nextId = 1;
  let beltPos = 0;
  let cylPos = 0; // 0 = 完全縮回,1 = 完全推出
  let feedTimer = 0;
  let countOk = 0;
  let countNg = 0;
  let countReturned = 0;
  let lastFallen = null; // 給 3D 做掉落動畫用
  // 最近一次通過檢測位的零件判定。bPartIsNg 只在零件停留在感測窗內的
  // 零點幾秒有效,肉眼很容易錯過,所以另外留一份給畫面顯示 —— 純視覺輔助,
  // 不影響送進 PLC 的訊號。
  let lastInspect = null;

  function reset() {
    parts = [];
    nextId = 1;
    beltPos = 0;
    cylPos = 0;
    feedTimer = 0;
    countOk = 0;
    countNg = 0;
    countReturned = 0;
    lastFallen = null;
    lastInspect = null;
  }

  function spawn(ng) {
    parts.push({ id: nextId++, x: 0, lateral: 0, ng, pushed: false });
  }

  /** 找出停在指定位置感測器視窗內、且尚未被推離皮帶的零件 */
  function partAt(pos) {
    return parts.find((p) => Math.abs(p.x - pos) <= G.sensorWindow && p.lateral < 20);
  }

  function step(dt, out, params) {
    // --- 進料機構:啟動時依週期投料,停止時計時器凍結 ---
    if (out.feederRun) {
      feedTimer += dt;
      if (feedTimer >= params.feedInterval) {
        feedTimer -= params.feedInterval;
        spawn(Math.random() * 100 < params.ngRatio);
      }
    }

    // --- 皮帶輸送 ---
    // 正反轉同時給命令是接線或程式的典型錯誤:真實的電磁接觸器會互鎖,
    // 這裡讓皮帶直接停下並回報異常,學員才學得到要在 PLC 裡自己擋掉。
    const beltFault = Boolean(out.beltForward && out.beltReverse);
    let beltDir = 0;
    if (!beltFault) {
      if (out.beltForward) beltDir = 1;
      else if (out.beltReverse) beltDir = -1;
    }

    if (beltDir !== 0) {
      const dx = beltDir * params.beltSpeed * dt;
      beltPos += dx;
      for (const p of parts) {
        if (!p.pushed) p.x += dx;
      }
    }

    // --- 氣缸:等速趨近目標位置 ---
    const target = out.cylExtend ? 1 : 0;
    const rate = dt / Math.max(params.cylinderTime, 0.01);
    if (cylPos < target) cylPos = Math.min(target, cylPos + rate);
    else if (cylPos > target) cylPos = Math.max(target, cylPos - rate);

    // --- 推料:氣缸推出過半時,把停在檢測位的零件帶離皮帶 ---
    const pushDepth = cylPos * G.cylinderStroke;
    for (const p of parts) {
      if (!p.pushed && cylPos > 0.05 && Math.abs(p.x - G.posInspect) <= G.sensorWindow) {
        p.pushed = true;
      }
      // 推桿縮回時零件不會跟著回來 — 只記錄推到過的最遠位置
      if (p.pushed) p.lateral = Math.max(p.lateral, pushDepth);
    }

    // --- 移除離開系統的零件並計數 ---
    const remaining = [];
    for (const p of parts) {
      if (p.lateral >= REJECT_FALL_DISTANCE) {
        countNg++;
        lastFallen = { id: p.id, ng: true, x: p.x };
        continue;
      }
      if (p.x > G.beltLength) {
        countOk++;
        lastFallen = { id: p.id, ng: false, x: p.x };
        continue;
      }
      // 反轉開太久,零件被送回進料端掉出皮帶
      if (p.x < -RETURN_MARGIN) {
        countReturned++;
        continue;
      }
      remaining.push(p);
    }
    parts = remaining;

    if (out.resetCounters) {
      countOk = 0;
      countNg = 0;
      countReturned = 0;
    }

    const atInspect = partAt(G.posInspect);
    if (atInspect && lastInspect?.id !== atInspect.id) {
      lastInspect = { id: atInspect.id, ng: atInspect.ng };
    }

    const inputs = {
      sensorEntry: Boolean(partAt(G.posEntry)),
      sensorInspect: Boolean(atInspect),
      sensorExit: Boolean(partAt(G.posExit)),
      partIsNg: Boolean(atInspect?.ng),
      cylExtended: cylPos >= 0.98,
      cylRetracted: cylPos <= 0.02,
      beltFault,
      beltPos,
      countOk,
      countNg,
      countReturned,
    };

    const view = {
      parts: parts.map((p) => ({ id: p.id, x: p.x, lateral: p.lateral, ng: p.ng })),
      cylPos,
      beltPos,
      beltDir,
      beltFault,
      countOk,
      countNg,
      countReturned,
      lastFallen,
      // 'NG' / 'OK' / null:檢測位當下的判定
      inspectNow: atInspect ? (atInspect.ng ? 'NG' : 'OK') : null,
      lastInspect,
    };

    return { inputs, view };
  }

  function command(name) {
    switch (name) {
      case 'injectOk':
        spawn(false);
        return '已投入 1 件 OK 品';
      case 'injectNg':
        spawn(true);
        return '已投入 1 件 NG 品';
      case 'clearParts':
        parts = [];
        return '皮帶已清空';
      default:
        return null;
    }
  }

  reset();
  return { reset, step, command };
}

export default { id: def.id, createModel };
