import def from '../../shared/scenarios/tank.js';

const G = def.geometry;
const WATER_HEAT_CAPACITY = 4186; // J/(kg·K),1 L 水 ≈ 1 kg
const MIN_VOLUME = 0.5; // L,避免空槽時熱容為零導致溫度發散

export function createModel() {
  let level = 0; // mm
  let temp = 25; // °C
  let flowIn = 0; // L/min
  let flowOut = 0; // L/min

  function reset(params) {
    level = 0;
    temp = params?.ambientTemp ?? 25;
    flowIn = 0;
    flowOut = 0;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function step(dt, out, params) {
    const inlet = clamp(out.inletValve, 0, 100);
    const outlet = clamp(out.outletValve, 0, 100);
    const heater = clamp(out.heaterPower, 0, 100);

    // --- 流量 ---
    // 進料閥再開,泵沒轉就沒有流量 — 這個互鎖是刻意留給學員踩的坑
    flowIn = out.pumpRun ? params.inletKv * inlet : 0;
    // 出料採托里切利定律:流速正比於液位高度的平方根
    flowOut = params.outletKv * outlet * Math.sqrt(clamp(level, 0, G.tankHeight) / G.tankHeight) * 10;
    if (level <= 0) flowOut = 0;

    // --- 液位積分 ---
    // V(L) = 截面積(dm²) × 液位(dm) = area × level_mm / 100
    // ⇒ dLevel_mm/dt = (Qin - Qout)[L/s] × 100 / area
    const netFlowLps = (flowIn - flowOut) / 60;
    const area = Math.max(params.tankArea, 0.1);
    level = clamp(level + (netFlowLps * 100 * dt) / area, 0, G.tankHeight);

    // --- 溫度能量平衡 ---
    const volume = Math.max((area * level) / 100, MIN_VOLUME); // L
    const heatCapacity = volume * WATER_HEAT_CAPACITY; // J/K

    // 沒攪拌時加熱效率打折(局部過熱),散熱也變差
    const mixing = out.mixerRun ? 1 : 0.7;
    const qHeater = params.heaterKw * 1000 * (heater / 100) * mixing; // W
    const qLoss = params.heatLoss * (temp - params.ambientTemp) * (out.mixerRun ? 1 : 0.8); // W
    // 進料冷水稀釋槽溫;出流是等溫排出,不影響剩餘液體的溫度
    const qInflow = (flowIn / 60) * WATER_HEAT_CAPACITY * (params.inletTemp - temp); // W

    const dTemp = ((qHeater - qLoss + qInflow) / heatCapacity) * dt;
    temp = clamp(temp + dTemp, -10, G.maxTemp);

    const levelPercent = (level / G.tankHeight) * 100;
    const dryRun = level < G.dryRunLevel && heater > 0;

    const inputs = {
      level,
      levelPercent,
      temperature: temp,
      flowIn,
      flowOut,
      levelLowLow: level <= G.thresholds.lowLow,
      levelLow: level <= G.thresholds.low,
      levelHigh: level >= G.thresholds.high,
      levelHighHigh: level >= G.thresholds.highHigh,
      overTemp: temp >= G.overTempLimit,
      dryRun,
    };

    const view = {
      level,
      levelPercent,
      temperature: temp,
      flowIn,
      flowOut,
      inletValve: inlet,
      outletValve: outlet,
      heaterPower: heater,
      pumpRun: Boolean(out.pumpRun),
      mixerRun: Boolean(out.mixerRun),
      alarms: {
        overTemp: inputs.overTemp,
        dryRun,
        highHigh: inputs.levelHighHigh,
        lowLow: inputs.levelLowLow,
      },
    };

    return { inputs, view };
  }

  function command(name, args, params) {
    switch (name) {
      case 'drain':
        level = 0;
        return '槽體已排空';
      case 'fillHalf':
        level = G.tankHeight / 2;
        return '已預填至 50%';
      case 'coolDown':
        temp = params?.ambientTemp ?? 25;
        return '溫度已降至環境溫度';
      default:
        return null;
    }
  }

  reset();
  return { reset, step, command };
}

export default { id: def.id, createModel };
