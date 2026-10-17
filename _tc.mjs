import { Client } from 'ads-client';

// 用法: node _tc.mjs [AmsNetId ...]   不帶參數時只測 loopback
const targets = (process.argv.length > 2 ? process.argv.slice(2) : ['127.0.0.1.1.1'])
  .map((id) => [id === '127.0.0.1.1.1' ? 'loopback' : '指定目標', id]);

const first = (s) => String(s ?? '').split('\n')[0];

for (const [name, netid] of targets) {
  try {
    const sys = new Client({
      targetAmsNetId: netid,
      targetAdsPort: 10000,
      hideConsoleWarnings: true,
      timeoutDelay: 3000,
      allowHalfOpen: true,
    });
    await sys.connect();
    const st = await sys.readTcSystemState();
    console.log(`${name.padEnd(9)} ${netid.padEnd(20)} TwinCAT 系統 = ${st.adsStateStr}`);
    await sys.disconnect();
  } catch (e) {
    console.log(`${name.padEnd(9)} ${netid.padEnd(20)} 系統服務連不上:${first(e.message)}`);
    continue;
  }

  try {
    const plc = new Client({
      targetAmsNetId: netid,
      targetAdsPort: 851,
      hideConsoleWarnings: true,
      timeoutDelay: 3000,
      allowHalfOpen: true,
    });
    await plc.connect();
    const p = await plc.readPlcRuntimeState();
    console.log(`${' '.repeat(30)}port 851 PLC = ${p.adsStateStr}`);
    await plc.disconnect();
  } catch (e) {
    console.log(`${' '.repeat(30)}port 851 讀不到:${first(e.message)}`);
  }
}
