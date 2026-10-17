/**
 * IEC 61131-3 基本型別 ↔ Buffer 的同步編解碼。
 *
 * ads-client 也提供 convertFromRaw / convertToRaw,但那是 async 且需查詢資料型別表。
 * 模擬迴圈每 50ms 要處理數十個訊號,這裡自己處理基本型別以省下往返與 await。
 * 只涵蓋純量基本型別 — 場景定義刻意不使用 STRUCT / STRING / ARRAY。
 */

const CODECS = {
  BOOL: {
    size: 1,
    decode: (b, o) => b.readUInt8(o) !== 0,
    encode: (b, o, v) => b.writeUInt8(v ? 1 : 0, o),
    coerce: (v) => Boolean(v),
  },
  BYTE: { size: 1, decode: (b, o) => b.readUInt8(o), encode: (b, o, v) => b.writeUInt8(clampInt(v, 0, 255), o), coerce: toInt },
  USINT: { size: 1, decode: (b, o) => b.readUInt8(o), encode: (b, o, v) => b.writeUInt8(clampInt(v, 0, 255), o), coerce: toInt },
  SINT: { size: 1, decode: (b, o) => b.readInt8(o), encode: (b, o, v) => b.writeInt8(clampInt(v, -128, 127), o), coerce: toInt },
  WORD: { size: 2, decode: (b, o) => b.readUInt16LE(o), encode: (b, o, v) => b.writeUInt16LE(clampInt(v, 0, 65535), o), coerce: toInt },
  UINT: { size: 2, decode: (b, o) => b.readUInt16LE(o), encode: (b, o, v) => b.writeUInt16LE(clampInt(v, 0, 65535), o), coerce: toInt },
  INT: { size: 2, decode: (b, o) => b.readInt16LE(o), encode: (b, o, v) => b.writeInt16LE(clampInt(v, -32768, 32767), o), coerce: toInt },
  DWORD: { size: 4, decode: (b, o) => b.readUInt32LE(o), encode: (b, o, v) => b.writeUInt32LE(clampInt(v, 0, 4294967295), o), coerce: toInt },
  UDINT: { size: 4, decode: (b, o) => b.readUInt32LE(o), encode: (b, o, v) => b.writeUInt32LE(clampInt(v, 0, 4294967295), o), coerce: toInt },
  DINT: { size: 4, decode: (b, o) => b.readInt32LE(o), encode: (b, o, v) => b.writeInt32LE(clampInt(v, -2147483648, 2147483647), o), coerce: toInt },
  REAL: { size: 4, decode: (b, o) => b.readFloatLE(o), encode: (b, o, v) => b.writeFloatLE(toFloat(v), o), coerce: toFloat },
  LREAL: { size: 8, decode: (b, o) => b.readDoubleLE(o), encode: (b, o, v) => b.writeDoubleLE(toFloat(v), o), coerce: toFloat },
};

function toInt(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
}

function toFloat(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampInt(v, min, max) {
  return Math.min(max, Math.max(min, toInt(v)));
}

export function getCodec(type) {
  const codec = CODECS[String(type).toUpperCase()];
  if (!codec) throw new Error(`不支援的 PLC 型別:${type}`);
  return codec;
}

export function decodeValue(type, buffer, offset = 0) {
  return getCodec(type).decode(buffer, offset);
}

export function encodeValue(type, value) {
  const codec = getCodec(type);
  const buf = Buffer.alloc(codec.size);
  codec.encode(buf, 0, value);
  return buf;
}

/** 依型別把任意輸入正規化成合法的 PLC 值 — 前端手動覆寫時用得上 */
export function coerceValue(type, value) {
  return getCodec(type).coerce(value);
}

export function sizeOf(type) {
  return getCodec(type).size;
}

/** 型別的預設值,用於尚未連線時初始化 */
export function defaultValue(type) {
  return String(type).toUpperCase() === 'BOOL' ? false : 0;
}
