import conveyor from './conveyor.js';
import gantry from './gantry.js';
import tank from './tank.js';

/** 場景 id → 物理模型工廠 */
export const models = {
  [conveyor.id]: conveyor.createModel,
  [gantry.id]: gantry.createModel,
  [tank.id]: tank.createModel,
};

export function createModelFor(id) {
  const factory = models[id];
  if (!factory) throw new Error(`找不到場景「${id}」的物理模型`);
  return factory();
}

export default models;
