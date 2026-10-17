/**
 * 執行環境設定。所有值都可用環境變數覆寫,網頁端也能在執行中改 ADS 連線設定。
 */
export const config = {
  /** HTTP / WebSocket 監聽埠 */
  port: Number(process.env.SIM_PORT ?? 3300),

  /**
   * 'ads'  = 真的連 TwinCAT
   * 'mock' = 不連 PLC,致動器命令改由網頁手動切換(無 TwinCAT 也能開發/教學)
   */
  mode: process.env.SIM_MODE === 'mock' ? 'mock' : 'ads',

  /**
   * 模擬迴圈週期 (ms)。物理積分與 ADS 讀寫都跟著這個節奏。
   *
   * 20 ms 是感測器解析度與負載的折衷:皮帶跑到 600 mm/s 時,零件通過
   * ±30 mm 的感測窗只有 100 ms,週期太長會直接漏檢。本機 ADS 批次往返
   * 實測不到 1 ms,20 ms 綽綽有餘。
   */
  cycleTime: Number(process.env.SIM_CYCLE ?? 20),

  /** 推送給網頁的狀態更新週期 (ms),與模擬週期解耦以免灌爆瀏覽器 */
  pushTime: Number(process.env.SIM_PUSH ?? 33),

  /** 沒有上次紀錄時載入的場景 */
  defaultScenario: process.env.SIM_SCENARIO ?? 'conveyor',

  /** 用 SIM_SCENARIO 指定的話就固定用它,不理會上次離開時停在哪個場景 */
  scenarioPinned: Boolean(process.env.SIM_SCENARIO),

  ads: {
    /**
     * 目標 TwinCAT 的 AmsNetId。
     *
     * '127.0.0.1.1.1' 是本機 loopback(不需要 ADS Route),但只有在 PLC runtime
     * 確實掛在 loopback 下才通 —— 實務上常常要填 XAR 實際的 AmsNetId。
     * 網頁的「連線設定」可以隨時改,不必動這裡。
     */
    targetAmsNetId: process.env.ADS_NETID ?? '127.0.0.1.1.1',
    /** PLC Runtime 埠號:第一個 runtime = 851,第二個 = 852,依此類推 */
    targetAdsPort: Number(process.env.ADS_PORT ?? 851),
    /** 連遠端時填對方 IP;本機留空由 ads-client 自行判斷 */
    routerAddress: process.env.ADS_ROUTER || undefined,
    routerTcpPort: Number(process.env.ADS_ROUTER_PORT ?? 48898),
  },
};

export default config;
