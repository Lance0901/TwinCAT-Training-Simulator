import conveyor from './conveyor.js';
import gantry from './gantry.js';
import tank from './tank.js';

export const scenarios = [conveyor, gantry, tank];

export const scenarioMap = Object.fromEntries(scenarios.map((s) => [s.id, s]));

export function getScenario(id) {
  return scenarioMap[id];
}

/** 取得某個訊號在 PLC 端的完整符號路徑,例如 `GVL_Conveyor.bBeltRun` */
export function tagPath(scenario, signal) {
  return `${scenario.namespace}.${signal.tag}`;
}

export default scenarios;
