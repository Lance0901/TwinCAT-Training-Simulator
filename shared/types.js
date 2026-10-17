/**
 * PLC 型別的相容性判定。
 *
 * 場景定義寫的型別(例如 REAL)只是「建議宣告」。真實專案裡位置常常宣告成
 * LREAL、計數宣告成 UDINT,硬要求完全相同的話,學員手上的變數一個都接不上。
 *
 * 所以只分兩類:
 *   - bool    : BOOL
 *   - numeric : 其餘所有數值型別
 *
 * 同類就允許綁定,實際讀寫一律依「PLC 那側的真實型別」編解碼 ——
 * 拿 REAL 的 codec 去讀 LREAL 會抓到錯誤的 4 個位元組,那才是真正危險的事。
 */

const NUMERIC = new Set([
  'BYTE',
  'USINT',
  'SINT',
  'WORD',
  'UINT',
  'INT',
  'DWORD',
  'UDINT',
  'DINT',
  'REAL',
  'LREAL',
]);

export function typeClass(type) {
  const t = String(type ?? '').toUpperCase();
  if (t === 'BOOL') return 'bool';
  if (NUMERIC.has(t)) return 'numeric';
  return null;
}

/** 場景訊號的型別能不能接到這個 PLC 型別的變數 */
export function isCompatible(signalType, plcType) {
  const a = typeClass(signalType);
  return a !== null && a === typeClass(plcType);
}

export function isFloatType(type) {
  const t = String(type ?? '').toUpperCase();
  return t === 'REAL' || t === 'LREAL';
}

/**
 * 挑選清單的排序用:型別越貼近訊號的排越前面。
 * 0 = 完全相同、1 = 同為浮點或同為整數、2 = 數值但一邊浮點一邊整數。
 *
 * 沒有這層排序的話,要接 REAL 時滿眼都會是 BYTE / DWORD 的系統常數,
 * 真正該用的 LREAL 反而被埋在幾百筆之後。
 */
export function typeAffinity(signalType, plcType) {
  const s = String(signalType ?? '').toUpperCase();
  const p = String(plcType ?? '').toUpperCase();
  if (s === p) return 0;
  return isFloatType(s) === isFloatType(p) ? 1 : 2;
}

/** 一看就知道是 TwinCAT 內建函式庫的符號,挑選時排到後面 */
export function isBuiltinSymbol(name) {
  return /^(Global_Variables|Global_Constants|GVL_INTERNAL|Constants|TwinCAT_|_Implicit|Tc[0-9])/i.test(
    String(name ?? ''),
  );
}

/**
 * 型別不同但相容時,值得提醒使用者可能的副作用。
 * 回傳 null 代表沒什麼好提醒的。
 */
export function conversionNote(signalType, plcType) {
  const s = String(signalType).toUpperCase();
  const p = String(plcType).toUpperCase();
  if (s === p) return null;

  const sFloat = s === 'REAL' || s === 'LREAL';
  const pFloat = p === 'REAL' || p === 'LREAL';

  if (sFloat && !pFloat) return `小數會被截斷(訊號是 ${s},PLC 變數是 ${p})`;
  if (!sFloat && pFloat) return `整數存入浮點數(訊號是 ${s},PLC 變數是 ${p})`;
  if (s === 'LREAL' && p === 'REAL') return '雙精度存入單精度,會損失精度';
  return `型別不同但相容(訊號 ${s} → PLC ${p})`;
}
