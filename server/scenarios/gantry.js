import def from '../../shared/scenarios/gantry.js';

const G = def.geometry;
const CELL_COUNT = G.placeGrid.cols * G.placeGrid.rows;
const TRAY_CAPACITY = G.pickGrid.cols * G.pickGrid.rows;

/** 格位編號 → 該格中心座標。取料盤與放料盤共用同一套編號規則 */
function gridPoint(grid, index) {
  return {
    x: grid.x0 + (index % grid.cols) * grid.dx,
    y: grid.y0 + Math.floor(index / grid.cols) * grid.dy,
  };
}

/**
 * 機械的縮放係數 [mm/inc]:一個增量讓機構走多遠。
 *
 * 這是純粹的機械事實,和 NC 怎麼設定完全無關 —— 驅動器收到幾個脈衝,
 * 螺桿就轉多少,機構就走多遠。NC 的 Scaling Factor 設錯,就是會撞。
 */
function mmPerInc(params) {
  const enc = Math.max(params.encInc ?? 1, 1);
  const gear = Math.max(params.gear ?? 1, 0.01);
  return (params.pitch ?? 10) / (enc * gear);
}

/** 放料格 index → 該格中心座標 */
function cellCenter(index) {
  return gridPoint(G.placeGrid, index);
}

/** 找出目前位置正對著哪一格放料格,不在任何格上就回傳 -1 */
function cellUnder(x, y) {
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = cellCenter(i);
    if (Math.hypot(x - c.x, y - c.y) <= G.tolerance) return i;
  }
  return -1;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function createModel() {
  // 機構的真實位置。跟隨 NC 的 ActPos,但被機械擋塊夾在行程內。
  let x = 0;
  let y = 0;
  let prevX = 0;
  let prevY = 0;
  let vx = 0;
  let vy = 0;
  let lastMovingSpeed = 0;

  let nozzle = 0; // 0 = 上限位,1 = 下限位
  let vacuumTimer = 0;
  let holding = false;
  let trayRemaining = TRAY_CAPACITY;
  let placed = new Set();
  let dropped = [];
  let countPlaced = 0;
  let prevVacuum = false;
  let lastEvent = null;

  // 碰撞是閂鎖的:撞過就一直亮著,等 PLC 或網頁確認
  let collision = false;
  let collisionAxis = 0;
  let followError = 0;
  let impactSpeed = 0;
  let impactPoints = []; // 給 3D 標出撞在哪

  // 撞過之後機構與 NC 的座標就對不上了。承認警報只是關掉蜂鳴器,
  // 這個旗標要等機構真的回到原點感測器才會消失 —— 跟真實機台一樣。
  let homingRequired = false;

  function reset() {
    x = 0;
    y = 0;
    prevX = 0;
    prevY = 0;
    vx = 0;
    vy = 0;
    lastMovingSpeed = 0;
    nozzle = 0;
    vacuumTimer = 0;
    holding = false;
    trayRemaining = TRAY_CAPACITY;
    placed = new Set();
    dropped = [];
    countPlaced = 0;
    prevVacuum = false;
    lastEvent = null;
    clearAlarm();
  }

  /** 承認警報:關掉碰撞旗標,但不碰 homingRequired */
  function ackAlarm() {
    collision = false;
    collisionAxis = 0;
    followError = 0;
    impactSpeed = 0;
    impactPoints = [];
  }

  /** 完整解除,含座標可信度 —— 只有原點復歸完成或維修強制才走這條 */
  function clearAlarm() {
    ackAlarm();
    homingRequired = false;
  }

  function step(dt, out, params) {
    // --- 1. 機構跟隨 NC 回報的位置,但行程是硬的 ---
    //
    // 這是整個場景的核心:模擬器不再自己算運動,NC 才是軸模型。
    // 機構只能待在 0..stroke 之間,NC 命令跑出去,機構就停在擋塊上,
    // 兩者的差就是跟隨誤差 —— 真實撞機時看到的正是這個現象。
    const ncX = Number.isFinite(out.ncPosX) ? out.ncPosX : 0;
    const ncY = Number.isFinite(out.ncPosY) ? out.ncPosY : 0;

    // 機構跟隨的是「增量」,不是 NC 換算後的 mm。
    // NC 的 Scaling Factor 設錯,送出的增量數就錯,機構自然走錯距離 ——
    // 模擬器不需要知道 NC 設了什麼,照機械規格換算就是了。
    //
    // 增量填 0 時退回用 rNcActPosX 當 mm 直接使用,方便手動模擬與尚未接 NC 的情況。
    const scale = mmPerInc(params);
    const incX = Number.isFinite(out.ncIncX) ? out.ncIncX : 0;
    const incY = Number.isFinite(out.ncIncY) ? out.ncIncY : 0;
    const usingInc = incX !== 0 || incY !== 0;

    const realX = usingInc ? incX * scale : ncX;
    const realY = usingInc ? incY * scale : ncY;

    x = clamp(realX, 0, G.strokeX);
    y = clamp(realY, 0, G.strokeY);

    if (dt > 0) {
      vx = (x - prevX) / dt;
      vy = (y - prevY) / dt;
    }
    prevX = x;
    prevY = y;

    // 留住最近一次「確實在動」的速度,撞擊時要拿它當撞擊速度。
    // 上限用來擋掉位置瞬間跳變(手動輸入、剛連線、NC 重新設定原點)算出的假速度。
    const speed = Math.hypot(vx, vy);
    if (speed > 1 && speed < 5000) lastMovingSpeed = speed;

    // --- 2. 碰撞判定 ---
    // 判定依據是換算後的實際位置,不是 NC 以為的位置。
    // scaling 設錯時 NC 認為自己還在行程內,機構卻早就頂在擋塊上了。
    const tol = G.hardStopTolerance;
    const overX = realX < -tol || realX > G.strokeX + tol;
    const overY = realY < -tol || realY > G.strokeY + tol;
    followError = Math.max(followError, Math.abs(realX - x), Math.abs(realY - y));

    if (overX || overY) {
      if (!collision) {
        // 撞上的當下機構已經停住,現在算出來的速度會是 0 ——
        // 要的是「撞擊前一刻」的速度,所以用最近一次還在移動時記下的值。
        impactSpeed = lastMovingSpeed;
        lastEvent = { type: 'collision', at: Date.now() };
      }
      collision = true;
      // 撞過就得重建座標,這個旗標不會隨警報確認一起消失
      homingRequired = true;
      collisionAxis = (overX ? 1 : 0) | (overY ? 2 : 0);
      const point = { x, y, at: Date.now() };
      if (impactPoints.length === 0 || Math.hypot(impactPoints.at(-1).x - x, impactPoints.at(-1).y - y) > 5) {
        impactPoints.push(point);
        if (impactPoints.length > 6) impactPoints.shift();
      }
    }

    // 警報確認只承認事件,不代表座標就恢復可信
    if (out.resetAlarm) ackAlarm();

    // 原點復歸完成的唯一判定:機構真的開回兩軸的原點感測器範圍內。
    // 這也是為什麼撞完不能只按 reset —— 得把機器實際開回原點。
    const atHome = x <= G.homeWindow && y <= G.homeWindow;
    if (homingRequired && !collision && atHome) {
      homingRequired = false;
      lastEvent = { type: 'homed', at: Date.now() };
    }

    // --- 3. 吸嘴升降 ---
    const nozzleTarget = out.nozzleDown ? 1 : 0;
    const nozzleRate = dt / Math.max(params.nozzleTime, 0.01);
    if (nozzle < nozzleTarget) nozzle = Math.min(nozzleTarget, nozzle + nozzleRate);
    else if (nozzle > nozzleTarget) nozzle = Math.max(nozzleTarget, nozzle - nozzleRate);

    const nozzleIsDown = nozzle >= 0.98;
    const nozzleIsUp = nozzle <= 0.02;

    // 取料盤是一格一格取的:第 0 格取完換第 1 格,依此類推。
    // 吸嘴得移到「當前這一格」才吸得到 —— 停在別格上是吸空氣。
    const nextPickIndex = trayRemaining > 0 ? TRAY_CAPACITY - trayRemaining : -1;
    const pickSlot = nextPickIndex >= 0 ? gridPoint(G.pickGrid, nextPickIndex) : null;
    const atPick = pickSlot ? Math.hypot(x - pickSlot.x, y - pickSlot.y) <= G.tolerance : false;
    const settle = params.settleSpeed ?? 5;
    const nearlyStopped = Math.abs(vx) < settle && Math.abs(vy) < settle;

    // --- 4. 真空吸附 ---
    // 座標不可信就不讓吸附成立 —— 撞機當下如此,警報確認後、尚未復歸也是如此。
    // (真空本身是氣路,與軸有沒有致能無關,所以這裡只看座標可信度。)
    const positionTrusted = !collision && !homingRequired;
    if (out.vacuumOn && !holding && positionTrusted) {
      if (nozzleIsDown && atPick && nearlyStopped && trayRemaining > 0) {
        vacuumTimer += dt;
        if (vacuumTimer >= params.vacuumDelay) {
          holding = true;
          trayRemaining--;
          vacuumTimer = 0;
          lastEvent = { type: 'pick', at: Date.now() };
        }
      } else {
        vacuumTimer = 0;
      }
    }

    // --- 5. 放料:真空下降緣的瞬間決定成敗 ---
    if (prevVacuum && !out.vacuumOn && holding) {
      holding = false;
      vacuumTimer = 0;
      const cell = nozzleIsDown ? cellUnder(x, y) : -1;
      if (cell >= 0 && !placed.has(cell)) {
        placed.add(cell);
        countPlaced++;
        lastEvent = { type: 'place', cell, at: Date.now() };
      } else {
        dropped.push({ x, y, at: Date.now() });
        if (dropped.length > 20) dropped.shift();
        lastEvent = { type: 'drop', x, y, at: Date.now() };
      }
    }
    if (!out.vacuumOn) holding = false;
    prevVacuum = Boolean(out.vacuumOn);

    if (out.resetAlarm) {
      countPlaced = 0;
      placed = new Set();
      dropped = [];
    }

    const inputs = {
      machinePosX: x,
      machinePosY: y,
      followError,
      collision,
      collisionAxis,
      homingRequired,
      homeX: x <= G.homeWindow,
      homeY: y <= G.homeWindow,
      limitXNeg: x <= G.softLimit,
      limitXPos: x >= G.strokeX - G.softLimit,
      limitYNeg: y <= G.softLimit,
      limitYPos: y >= G.strokeY - G.softLimit,
      nozzleIsDown,
      nozzleIsUp,
      partHeld: holding,
      partAtPick: trayRemaining > 0,
      nextPickIndex,
      countPlaced,
    };

    const view = {
      x,
      y,
      vx,
      vy,
      ncX,
      ncY,
      incX,
      incY,
      usingInc,
      mmPerInc: scale,
      // NC 若也照這組機械規格換算,ActPos 應該是這個值。差很多就代表 scaling 設錯了。
      commandedMm: usingInc ? realX : ncX,
      nozzle,
      holding,
      trayRemaining,
      nextPickIndex,
      placed: [...placed],
      dropped,
      countPlaced,
      collision,
      collisionAxis,
      homingRequired,
      followError,
      impactSpeed,
      impactPoints,
      lastEvent,
    };

    return { inputs, view };
  }

  function command(name) {
    switch (name) {
      case 'refillPick':
        trayRemaining = TRAY_CAPACITY;
        return `取料盤已補滿(${TRAY_CAPACITY} 件)`;
      case 'clearPlaced':
        placed = new Set();
        dropped = [];
        return '放料盤已清空';
      case 'ackAlarm':
        ackAlarm();
        return homingRequired
          ? '警報已確認 —— 但座標仍不可信,請把機構開回原點(X、Y 都要 ≤ 8 mm)'
          : '警報已確認';
      case 'forceHomed':
        clearAlarm();
        return '已強制標記為完成復歸(維修用,正常流程請實際開回原點)';
      default:
        return null;
    }
  }

  reset();
  return { reset, step, command };
}

export default { id: def.id, createModel };
