/**
 * 場景 3:液位 / 溫度反應槽
 *
 * 教學重點:類比訊號、PID 調變、一階慣性系統、互鎖保護、警報處理
 *
 * 液位:dV/dt = Qin - Qout,出料採托里切利定律 Qout ∝ √h
 * 溫度:加熱功率、進料冷水混合、環境散熱三者的能量平衡
 */
export default {
  id: 'tank',
  name: '液位溫度反應槽',
  subtitle: 'Level & Temperature Process Tank',
  description:
    '進料泵配比例閥控制入流,出料閥洩流,電熱器加溫。適合練習 PID 調變、類比訊號縮放與高低液位互鎖。',
  topics: ['REAL 類比量', 'PID 控制', '一階慣性系統', '互鎖保護', '警報處理'],
  namespace: 'GVL_Tank',

  /** PLC → 模擬器:PLC 的輸出,也就是「工程師能控制什麼」 */
  outputs: [
    {
      key: 'pumpRun',
      tag: 'bPumpRun',
      type: 'BOOL',
      label: '進料泵運轉',
      desc: '互鎖重點:這個訊號是 FALSE 時,進料閥開再大也完全沒有流量。',
    },
    {
      key: 'inletValve',
      tag: 'rInletValve',
      type: 'LREAL',
      label: '進料閥開度',
      unit: '%',
      desc: '0–100%,超出範圍會被夾住。入流量 = 開度 × 流量係數(需泵運轉)。',
    },
    {
      key: 'outletValve',
      tag: 'rOutletValve',
      type: 'LREAL',
      label: '出料閥開度',
      unit: '%',
      desc: '0–100%。出流量除了開度,還正比於液位的平方根(托里切利定律)。',
    },
    {
      key: 'heaterPower',
      tag: 'rHeaterPower',
      type: 'LREAL',
      label: '加熱器功率',
      unit: '%',
      desc: '0–100%,對應「加熱器額定功率」參數。液位過低時加熱會觸發乾燒警報。',
    },
    {
      key: 'mixerRun',
      tag: 'bMixerRun',
      type: 'BOOL',
      label: '攪拌器運轉',
      desc: 'OFF 時加熱效率降到 70%、散熱降到 80%,溫度響應會明顯不一樣。',
    },
  ],

  /** 模擬器 → PLC:PLC 的輸入,也就是「工程師會收到什麼」 */
  inputs: [
    { key: 'level', tag: 'rLevel', type: 'LREAL', label: '液位', unit: 'mm', desc: '量測範圍 0–1000 mm。' },
    { key: 'levelPercent', tag: 'rLevelPercent', type: 'LREAL', label: '液位百分比', unit: '%', desc: '等同 rLevel / 10,方便直接餵給 PID。' },
    { key: 'temperature', tag: 'rTemperature', type: 'LREAL', label: '槽內溫度', unit: '°C', desc: '槽內均溫,模型上限 120 °C。' },
    { key: 'flowIn', tag: 'rFlowIn', type: 'LREAL', label: '入流量', unit: 'L/min', desc: '實際入流量。泵沒運轉時恆為 0。' },
    { key: 'flowOut', tag: 'rFlowOut', type: 'LREAL', label: '出流量', unit: 'L/min', desc: '實際出流量。液位為 0 時恆為 0。' },
    { key: 'levelLowLow', tag: 'bLevelLowLow', type: 'BOOL', label: '極低液位 (LL)', desc: '液位 ≤ 100 mm 時 ON。' },
    { key: 'levelLow', tag: 'bLevelLow', type: 'BOOL', label: '低液位 (L)', desc: '液位 ≤ 200 mm 時 ON。' },
    { key: 'levelHigh', tag: 'bLevelHigh', type: 'BOOL', label: '高液位 (H)', desc: '液位 ≥ 800 mm 時 ON。' },
    { key: 'levelHighHigh', tag: 'bLevelHighHigh', type: 'BOOL', label: '極高液位 (HH)', desc: '液位 ≥ 900 mm 時 ON,應立即切斷進料。' },
    { key: 'overTemp', tag: 'bOverTemp', type: 'BOOL', label: '超溫警報', desc: '溫度 ≥ 85 °C 時 ON。' },
    {
      key: 'dryRun',
      tag: 'bDryRunAlarm',
      type: 'BOOL',
      label: '乾燒警報(空槽加熱)',
      desc: '液位 < 80 mm 且加熱器功率 > 0 時 ON。此時熱容很小,溫度會急速上升。',
    },
  ],

  params: [
    // 預設值刻意選成「實驗室規模」:滿槽約 80 L,滿功率升溫約 0.18 K/s。
    // 這樣一次 PID 調機實驗約 2~3 分鐘就能看到完整響應,不會讓學員等到失去耐性。
    // 想觀察大慣性系統的行為,把截面積調大、加熱功率調小即可。
    { key: 'tankArea', label: '槽體截面積', unit: 'dm²', min: 3, max: 100, step: 1, default: 8 },
    { key: 'inletKv', label: '進料閥流量係數', unit: 'L/min/%', min: 0.1, max: 3, step: 0.05, default: 0.8 },
    { key: 'outletKv', label: '出料閥流量係數', unit: '-', min: 0.05, max: 2, step: 0.05, default: 0.5 },
    { key: 'heaterKw', label: '加熱器額定功率', unit: 'kW', min: 1, max: 60, step: 1, default: 30 },
    { key: 'inletTemp', label: '進料水溫', unit: '°C', min: 5, max: 60, step: 1, default: 18 },
    { key: 'ambientTemp', label: '環境溫度', unit: '°C', min: 0, max: 45, step: 1, default: 25 },
    { key: 'heatLoss', label: '散熱係數', unit: 'W/K', min: 0, max: 200, step: 5, default: 25 },
  ],

  commands: [
    { key: 'drain', label: '緊急排空' },
    { key: 'fillHalf', label: '預填至 50%' },
    { key: 'coolDown', label: '瞬間降至室溫' },
  ],

  geometry: {
    tankHeight: 1000, // mm,對應液位 0..1000
    thresholds: { lowLow: 100, low: 200, high: 800, highHigh: 900 },
    overTempLimit: 85, // °C
    dryRunLevel: 80, // 低於此液位又在加熱 → 乾燒警報
    maxTemp: 120,
  },
};
