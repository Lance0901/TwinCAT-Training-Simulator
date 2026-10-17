import { Client } from 'ads-client';

/**
 * 找出這台電腦能連到哪些 TwinCAT。
 *
 * 為什麼不是廣播掃描:TwinCAT 的「Add Route」對話框是靠 UDP 48899 廣播找設備的,
 * 但那個埠被 TCATSysSrv 獨佔(自己 bind 會拿到 EACCES),所以我們發得出去、收不回來。
 * 改成直接問本機 AMS Router 的路由表 —— 而且這樣更實在:廣播找得到的設備若沒有
 * 建立雙向 route,填了 NetId 一樣連不上,列出來只會誤導。
 *
 * 路由表走系統服務(AMS port 10000)的 IndexGroup 0x323,indexOffset 就是第幾筆,
 * 讀到底會拋錯,以此當結束條件。
 */

const SYSTEMSERVICE_PORT = 10000;
const ADSIGRP_SYSSERV_ENUMREMOTE = 0x323;
const LOOPBACK_NETID = '127.0.0.1.1.1';

/**
 * 一筆路由的位元組長相(實測 TwinCAT 3.1.4026):
 *
 *   0..5    AmsNetId
 *   32..35  位址字串長度(含結尾 \0)
 *   36..39  名稱字串長度(含結尾 \0)
 *   44..    位址字串、名稱字串,依序排列
 */
function parseRoute(buf) {
  const netId = [...buf.subarray(0, 6)].join('.');
  const addrLen = buf.readUInt32LE(32);
  const nameLen = buf.readUInt32LE(36);

  const cstr = (start, len) => {
    if (len <= 0 || start + len > buf.length) return '';
    return buf.toString('utf8', start, start + len).replace(/\0.*$/, '');
  };

  return {
    netId,
    address: cstr(44, addrLen),
    name: cstr(44 + addrLen, nameLen),
  };
}

/**
 * 對單一目標問一次狀態,失敗不算錯 —— 掃描本來就會遇到關機的機器。
 *
 * 這裡刻意 **不開** allowHalfOpen:連線用的那條路徑開著它是為了讓學員先開模擬器
 * 再開 TwinCAT,但掃描的目的就是分辨誰活著,半開連線會把離線的機器也報成連得上。
 */
async function probe(netId, timeoutDelay) {
  const client = new Client({
    targetAmsNetId: netId,
    targetAdsPort: SYSTEMSERVICE_PORT,
    hideConsoleWarnings: true,
    // 目標是系統服務,不是 PLC runtime。用一般模式連,ads-client 會去訂閱
    // 符號版本而失敗;rawClient 只建立 AMS 連線,正好符合掃描的需求。
    rawClient: true,
    timeoutDelay,
  });
  try {
    await client.connect();
    let system = null;
    try {
      system = (await client.readTcSystemState())?.adsStateStr ?? null;
    } catch {
      /* 目標沒回應,下面會判成連不上 */
    }
    let plc = null;
    try {
      // 同一條連線換個 AMS port 問就好,不必再握手一次
      plc = (await client.readPlcRuntimeState({ adsPort: 851 }))?.adsStateStr ?? null;
    } catch {
      /* 沒有 PLC runtime */
    }

    // connect() 成功只代表連上「本機」的 AMS Router —— AMS 封包是由它轉發的,
    // 對面關機時一樣握手得起來。真正的判準是目標有沒有回應 ADS 請求。
    const reachable = system !== null || plc !== null;
    return {
      reachable,
      system,
      plc,
      error: reachable ? null : '目標沒有回應(可能關機、不在同網段,或對方沒有回指本機的 route)',
    };
  } catch (err) {
    return { reachable: false, system: null, plc: null, error: String(err?.message ?? err).split('\n')[0] };
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* 清理失敗無所謂 */
    }
  }
}

/**
 * @param timeoutDelay 每個目標的等待上限。掃描要快,不能用連線用的那組值。
 * @returns { local, targets: [{ netId, address, name, source, reachable, system, plc }] }
 */
export async function scanTargets({ timeoutDelay = 1000, maxRoutes = 64 } = {}) {
  const router = new Client({
    targetAmsNetId: LOOPBACK_NETID,
    targetAdsPort: SYSTEMSERVICE_PORT,
    hideConsoleWarnings: true,
    rawClient: true,
    timeoutDelay,
  });

  let local = null;
  const routes = [];
  try {
    const conn = await router.connect();
    local = conn?.localAmsNetId ?? null;
    for (let i = 0; i < maxRoutes; i += 1) {
      try {
        routes.push(parseRoute(await router.readRaw(ADSIGRP_SYSSERV_ENUMREMOTE, i, 256)));
      } catch {
        break; // 讀到底了
      }
    }
  } catch (err) {
    throw new Error(`連不上本機 AMS Router,TwinCAT 可能沒有啟動:${String(err?.message ?? err).split('\n')[0]}`);
  } finally {
    try {
      await router.disconnect();
    } catch {
      /* 忽略 */
    }
  }

  const candidates = [
    { netId: LOOPBACK_NETID, address: 'localhost', name: '本機(loopback)', source: 'local' },
  ];
  if (local && local !== LOOPBACK_NETID) {
    candidates.push({ netId: local, address: 'localhost', name: '本機', source: 'local' });
  }
  for (const r of routes) {
    if (candidates.some((c) => c.netId === r.netId)) continue;
    candidates.push({ ...r, source: 'route' });
  }

  // 逐一問狀態。並行做,不然一台不通就要等滿一輪
  const probed = await Promise.all(
    candidates.map(async (c) => ({ ...c, ...(await probe(c.netId, timeoutDelay)) })),
  );

  return { local, targets: probed };
}

export default scanTargets;
