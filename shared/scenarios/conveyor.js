/**
 * 場景 1:輸送帶分料站
 *
 * 教學重點:數位 I/O、邊緣觸發、計時器 (TON)、狀態機、計數器
 *
 * outputs = PLC 寫、模擬器讀(致動器命令)
 * inputs  = 模擬器寫、PLC 讀(感測器回饋)
 */
export default {
  id: 'conveyor',
  name: '輸送帶分料站',
  subtitle: 'Conveyor & Sorting Station',
  description:
    '進料機構週期送料,皮帶輸送至檢測位判別 OK/NG,NG 品由氣缸推入退料槽,OK 品流向出料端計數。',
  topics: ['數位 I/O', '方向互鎖', 'TON 計時器', '上升緣偵測', '狀態機', '計數器'],
  namespace: 'GVL_Conveyor',

  /** PLC → 模擬器:PLC 的輸出,也就是「工程師能控制什麼」 */
  outputs: [
    {
      key: 'feederRun',
      tag: 'bFeederRun',
      type: 'BOOL',
      label: '進料機構啟動',
      desc: 'ON 期間依「進料週期」持續在皮帶起點投料;OFF 時計時器凍結,再啟動會接續。',
    },
    {
      key: 'beltForward',
      tag: 'bBeltForward',
      type: 'BOOL',
      label: '輸送帶正轉(往出料端)',
      desc: '皮帶往出料端運轉,速度由「皮帶速度」參數決定。與反轉同時 ON 會觸發互鎖並停帶。',
    },
    {
      key: 'beltReverse',
      tag: 'bBeltReverse',
      type: 'BOOL',
      label: '輸送帶反轉(往進料端)',
      desc: '皮帶倒送。零件退過起點 60 mm 就掉出系統,計入「退回進料端數」。',
    },
    {
      key: 'cylExtend',
      tag: 'bCylExtend',
      type: 'BOOL',
      label: '氣缸推出電磁閥',
      desc: '單動氣缸:ON 推出、OFF 自動縮回。沒有中間位置控制,行程時間由參數決定。',
    },
    {
      key: 'resetCounters',
      tag: 'bResetCounters',
      type: 'BOOL',
      label: '計數歸零',
      desc: '準位觸發(不是脈衝):ON 期間三個計數器持續維持 0。',
    },
  ],

  /** 模擬器 → PLC:PLC 的輸入,也就是「工程師會收到什麼」 */
  inputs: [
    {
      key: 'sensorEntry',
      tag: 'bSensorEntry',
      type: 'BOOL',
      label: '進料感測器 S1',
      desc: '零件中心位於皮帶 120 mm ±30 mm 時 ON。',
    },
    {
      key: 'sensorInspect',
      tag: 'bSensorInspect',
      type: 'BOOL',
      label: '檢測位感測器 S2',
      desc: '零件中心位於皮帶 520 mm ±30 mm 時 ON。分料氣缸就裝在這個位置。',
    },
    {
      key: 'sensorExit',
      tag: 'bSensorExit',
      type: 'BOOL',
      label: '出料感測器 S3',
      desc: '零件中心位於皮帶 900 mm ±30 mm 時 ON。',
    },
    {
      key: 'partIsNg',
      tag: 'bPartIsNg',
      type: 'BOOL',
      label: '檢測位為 NG 品',
      desc: '視覺檢測結果。只有在 S2 為 ON 時才有意義,零件離開後會歸 FALSE。',
    },
    {
      key: 'cylExtended',
      tag: 'bCylExtended',
      type: 'BOOL',
      label: '氣缸前限位',
      desc: '氣缸行程 ≥ 98% 時 ON。',
    },
    {
      key: 'cylRetracted',
      tag: 'bCylRetracted',
      type: 'BOOL',
      label: '氣缸後限位',
      desc: '氣缸行程 ≤ 2% 時 ON。',
    },
    {
      key: 'beltFault',
      tag: 'bBeltFault',
      type: 'BOOL',
      label: '皮帶方向互鎖異常',
      desc: '正轉與反轉同時被命令,皮帶已強制停止。程式不該讓這個訊號出現。',
    },
    {
      key: 'beltPos',
      tag: 'rBeltPos',
      type: 'LREAL',
      label: '皮帶累積位移',
      unit: 'mm',
      desc: '從啟動起算的累積位移,反轉時會減少。可用來推算零件位置。',
    },
    {
      key: 'countOk',
      tag: 'iCountOk',
      type: 'DINT',
      label: '出料端計數',
      desc: '從出料端離開皮帶的零件總數。這是位置計數器,不看好壞 —— 分料沒推成功的 NG 品也會算進來,正好可以用來檢驗分料程式對不對。',
    },
    {
      key: 'countNg',
      tag: 'iCountNg',
      type: 'DINT',
      label: '退料槽計數',
      desc: '被氣缸推入退料槽的零件總數。氣缸推走什麼就算什麼,推錯 OK 品一樣會計入。',
    },
    {
      key: 'countReturned',
      tag: 'iCountReturned',
      type: 'DINT',
      label: '退回進料端數',
      desc: '因反轉而退出進料端流失的零件數。正常生產時應該保持 0。',
    },
  ],

  /** 可在網頁上即時調整的物理參數 */
  params: [
    { key: 'beltSpeed', label: '皮帶速度', unit: 'mm/s', min: 20, max: 600, step: 10, default: 200 },
    { key: 'feedInterval', label: '進料週期', unit: 's', min: 0.5, max: 10, step: 0.1, default: 2.5 },
    { key: 'cylinderTime', label: '氣缸行程時間', unit: 's', min: 0.1, max: 3, step: 0.05, default: 0.4 },
    { key: 'ngRatio', label: 'NG 品比例', unit: '%', min: 0, max: 100, step: 5, default: 25 },
  ],

  /** 前端可下的手動指令(不經 PLC,直接作用於模擬器) */
  commands: [
    { key: 'injectOk', label: '手動投入 OK 品' },
    { key: 'injectNg', label: '手動投入 NG 品' },
    { key: 'clearParts', label: '清空皮帶' },
  ],

  /** 3D 場景幾何常數,前後端共用 */
  geometry: {
    beltLength: 1000, // mm
    beltWidth: 200,
    posEntry: 120, // 進料感測器位置
    posInspect: 520, // 檢測位 / 氣缸位置
    posExit: 900, // 出料感測器位置
    sensorWindow: 30, // 感測器觸發視窗(±mm)
    cylinderStroke: 180,
    rejectChuteDepth: 260,
  },
};
