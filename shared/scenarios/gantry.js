/**
 * 場景 2:XY 定位滑台(取放料)
 *
 * 教學重點:TwinCAT NC 虛擬軸、MC 功能塊、行程保護、碰撞判定、Pick & Place 流程
 *
 * 這個場景的軸不是模擬器算的 —— 運動控制完全交給 TwinCAT NC。
 * PLC 把 AXIS_REF.NcToPlc.ActPos 抄進 GVL,模擬器讀了之後直接驅動機構。
 *
 * 也就是說,模擬器扮演的是「機械本體」:
 *   - 機構跟隨 NC 的實際位置
 *   - 但機械行程是硬的,NC 命令超出去,機構會撞上擋塊並停住
 *   - 此時 NC 以為的位置與機構真正的位置產生落差 → 跟隨誤差 + 碰撞警報
 *
 * 學員因此會踩到真實世界的坑:NC 的軟體極限沒設好、或設得比機械行程還寬,
 * 程式跑起來一切正常,機器卻撞了。
 */
export default {
  id: 'gantry',
  name: 'XY 定位滑台',
  subtitle: 'XY Gantry Pick & Place (NC Axis)',
  description:
    '兩軸由 TwinCAT NC 虛擬軸驅動,模擬器依 NC 回報的 ActPos 移動機構,並在超出機械行程時判定撞機。',
  topics: ['NC 虛擬軸', 'MC 功能塊', '行程保護', '碰撞判定', 'Pick & Place 順序'],
  namespace: 'GVL_Gantry',

  /**
   * PLC → 模擬器:PLC 的輸出,也就是「工程師能控制什麼」
   *
   * 這裡沒有「軸致能」訊號 —— NC 模式下那是多餘的。MC_Power 沒致能,NC 就不會
   * 產生新的位置,增量不變,機構自然停著。模擬器不需要另外被告知一次。
   */
  outputs: [
    {
      key: 'ncPosX',
      tag: 'rNcActPosX',
      type: 'LREAL',
      label: 'X 軸 NC 實際位置',
      unit: 'mm',
      desc: '從 AxisX.NcToPlc.ActPos 抄進來。機構直接跟隨這個值 —— NC 命令跑出機械行程,機構就會撞擋塊。',
    },
    {
      key: 'ncPosY',
      tag: 'rNcActPosY',
      type: 'LREAL',
      label: 'Y 軸 NC 實際位置',
      unit: 'mm',
      desc: '從 AxisY.NcToPlc.ActPos 抄進來。',
    },
    // ---- 真正驅動機構的訊號(選用)----
    //
    // 存在的理由只有一個:讓「NC 的 Scaling Factor 設錯」這件事能真的發生。
    // 若只傳 mm,模擬器收到「100 mm」就把機構搬到 100 mm,NC 設成什麼都不影響結果,
    // 那個錯誤就演練不出來。改傳增量後,換算的責任回到機械這一側,
    // 兩邊規格不一致距離自然對不上 —— 模擬器全程不必知道 NC 設了什麼。
    //
    // 注意這在真實專案裡不存在:PLC 從 NcToPlc.ActPos 拿到的本來就是 mm,
    // 沒有人會去反算增量。不做這個演練就不用接這兩個訊號。
    {
      key: 'ncIncX',
      tag: 'iNcActIncX',
      type: 'DINT',
      label: 'X 軸馬達增量位置',
      unit: 'inc',
      desc:
        '選用。用來演練 NC scaling 設錯:機構走的距離 = 增量 × 螺桿導程 ÷ (編碼器解析度 × 減速比),' +
        '用的是模擬器這邊的機械規格。填 0 或不綁定時,模擬器改用 rNcActPosX 直接當 mm,行為與一般 NC 模擬相同。',
    },
    {
      key: 'ncIncY',
      tag: 'iNcActIncY',
      type: 'DINT',
      label: 'Y 軸馬達增量位置',
      unit: 'inc',
      desc: '選用,同 X 軸。',
    },
    {
      key: 'nozzleDown',
      tag: 'bNozzleDown',
      type: 'BOOL',
      label: '吸嘴下降',
      desc: 'ON 下降、OFF 上升。升降時間由參數決定,途中沒有位置回饋。',
    },
    {
      key: 'vacuumOn',
      tag: 'bVacuumOn',
      type: 'BOOL',
      label: '真空吸附',
      desc: '吸料:需停穩 + 吸嘴到下限位 + 位於取料位。放料成敗在此訊號的「下降緣」判定。',
    },
    {
      key: 'resetAlarm',
      tag: 'bResetAlarm',
      type: 'BOOL',
      label: '警報確認',
      desc:
        '承認碰撞警報,清掉 bCollision、跟隨誤差峰值與計數 —— 但不會清掉 bHomingRequired。' +
        '撞完只按這個就繼續跑,等於拿一組錯的座標開機。',
    },
  ],

  /** 模擬器 → PLC:PLC 的輸入,也就是「工程師會收到什麼」 */
  inputs: [
    {
      key: 'machinePosX',
      tag: 'rMachinePosX',
      type: 'LREAL',
      label: 'X 機構實際位置',
      unit: 'mm',
      desc: '被機械擋塊夾住後的真實位置,範圍 0–400 mm。正常時等於 NC 的 ActPos,撞機時會停在擋塊上不再跟隨。',
    },
    {
      key: 'machinePosY',
      tag: 'rMachinePosY',
      type: 'LREAL',
      label: 'Y 機構實際位置',
      unit: 'mm',
      desc: '範圍 0–300 mm,特性同 X 軸。',
    },
    {
      key: 'followError',
      tag: 'rFollowError',
      type: 'LREAL',
      label: '機構跟隨誤差',
      unit: 'mm',
      desc: 'NC 位置與機構位置的最大差值。正常為 0;撞上擋塊後 NC 繼續往前,這個值就會一路累積。',
    },
    {
      key: 'collision',
      tag: 'bCollision',
      type: 'BOOL',
      label: '碰撞警報',
      desc: 'NC 命令超出機械行程,機構已撞上擋塊。閂鎖訊號,bResetAlarm 可以「承認」這個警報 —— 但那只是關掉蜂鳴器,座標還是不能用,見 bHomingRequired。',
    },
    {
      key: 'homingRequired',
      tag: 'bHomingRequired',
      type: 'BOOL',
      label: '需要重新原點復歸',
      desc:
        '撞過擋塊後機構與 NC 的座標已經對不上,這個訊號會一直是 TRUE。' +
        '按警報復歸「不會」清掉它 —— 必須真的把機構開回原點感測器(X、Y 都進 8 mm 內)才會自動解除。' +
        '在那之前真空吸附一律不成立,因為位置不可信。',
    },
    {
      key: 'collisionAxis',
      tag: 'iCollisionAxis',
      type: 'INT',
      label: '碰撞軸別',
      desc: '0 = 無、1 = X 軸、2 = Y 軸、3 = 兩軸同時撞。',
    },
    { key: 'homeX', tag: 'bHomeSwitchX', type: 'BOOL', label: 'X 原點感測器', desc: '機構位置 ≤ 8 mm 時 ON,供 MC_Home 做原點復歸。' },
    { key: 'homeY', tag: 'bHomeSwitchY', type: 'BOOL', label: 'Y 原點感測器', desc: '機構位置 ≤ 8 mm 時 ON。' },
    {
      key: 'limitXNeg',
      tag: 'bLimitXNeg',
      type: 'BOOL',
      label: 'X 負向硬體極限',
      desc:
        '機構位置 ≤ 5 mm 時 ON。這是實體開關,和 NC 的軟體極限是兩回事。' +
        '注意它只是「回報」—— 亮了機構不會自己停,要不要停是你的程式要決定的。' +
        '不理它繼續往前,就會撞上 0 mm 的機械擋塊並觸發 bCollision。',
    },
    { key: 'limitXPos', tag: 'bLimitXPos', type: 'BOOL', label: 'X 正向硬體極限', desc: '機構位置 ≥ 395 mm 時 ON。同樣只回報,再往前 5 mm 就撞擋塊。' },
    { key: 'limitYNeg', tag: 'bLimitYNeg', type: 'BOOL', label: 'Y 負向硬體極限', desc: '機構位置 ≤ 5 mm 時 ON。同樣只回報,停不停由程式決定。' },
    { key: 'limitYPos', tag: 'bLimitYPos', type: 'BOOL', label: 'Y 正向硬體極限', desc: '機構位置 ≥ 295 mm 時 ON。同樣只回報,停不停由程式決定。' },
    { key: 'nozzleIsDown', tag: 'bNozzleIsDown', type: 'BOOL', label: '吸嘴下限位', desc: '吸嘴行程 ≥ 98% 時 ON。' },
    { key: 'nozzleIsUp', tag: 'bNozzleIsUp', type: 'BOOL', label: '吸嘴上限位', desc: '吸嘴行程 ≤ 2% 時 ON。' },
    {
      key: 'partHeld',
      tag: 'bPartHeld',
      type: 'BOOL',
      label: '真空確認(已吸住)',
      desc: '真空建立完成且確實吸住工件。吸附需要「真空建立延遲」的時間才會 ON。',
    },
    { key: 'partAtPick', tag: 'bPartAtPick', type: 'BOOL', label: '取料盤還有料', desc: '取料盤仍有工件可取(容量 12 件)。' },
    {
      key: 'nextPickIndex',
      tag: 'iNextPickIndex',
      type: 'INT',
      label: '下一個取料格編號',
      desc:
        '取料盤是一格一格取的,這個值告訴你下一顆在第幾格(0–11,取完為 -1)。' +
        '格位座標 = (40 + (i MOD 3) × 42, 40 + (i / 3) × 42)。移到別格是吸不到料的。',
    },
    { key: 'countPlaced', tag: 'iCountPlaced', type: 'DINT', label: '完成放料數', desc: '成功放入格位的累計數,最多 9(3×3 盤)。' },
  ],

  /**
   * 機械規格就在這裡設定。模擬器不去比對 NC 怎麼算的 —— 它只是照這組規格,
   * 把收到的增量換成實際位移:
   *
   *   位移 [mm] = 增量 × 螺桿導程 ÷ (編碼器解析度 × 減速比)
   *
   * NC 那邊的 Scaling Factor 必須算出同樣的值。舉例:這裡設一圈 1000 pulse、
   * NC 卻設成 10000,NC 為了走 10 mm 會送出 10 倍的增量,機構就走了 100 mm——
   * 沒幾個動作就撞上擋塊。這就是 scaling 設錯在真實機台上的樣子。
   */
  params: [
    // 這三個用數值輸入而不是滑桿 —— 伺服編碼器動輒 1048576 (2^20),
    // 拖滑桿根本對不準,而且這裡要的就是「跟 NC 設定一模一樣的數字」。
    { key: 'encInc', label: '馬達編碼器解析度', unit: 'inc/rev', min: 1, max: 100000000, step: 1, default: 10000, numeric: true },
    { key: 'pitch', label: '螺桿導程', unit: 'mm/rev', min: 0.1, max: 1000, step: 0.1, default: 10, numeric: true },
    { key: 'gear', label: '減速比(馬達:螺桿)', min: 0.1, max: 1000, step: 0.1, default: 2, numeric: true },
    { key: 'nozzleTime', label: '吸嘴升降時間', unit: 's', min: 0.1, max: 2, step: 0.05, default: 0.35 },
    { key: 'vacuumDelay', label: '真空建立延遲', unit: 's', min: 0, max: 2, step: 0.05, default: 0.2 },
    { key: 'settleSpeed', label: '停穩判定速度', unit: 'mm/s', min: 1, max: 50, step: 1, default: 5 },
  ],

  commands: [
    { key: 'refillPick', label: '補滿取料盤' },
    { key: 'clearPlaced', label: '清空放料盤' },
    { key: 'ackAlarm', label: '確認警報(等同 bResetAlarm)' },
    { key: 'forceHomed', label: '強制標記已復歸(維修用)' },
  ],

  geometry: {
    strokeX: 400, // mm,機械行程(硬擋塊之間)
    strokeY: 300,
    homeWindow: 8, // 原點感測器觸發範圍 (0..homeWindow)
    softLimit: 5, // 距離行程端點多少 mm 觸發硬體極限開關
    hardStopTolerance: 2, // NC 超出行程多少 mm 才算撞上擋塊(留給定位誤差)
    // 取料盤 3×4 共 12 格,從第 0 格開始一格一格取。
    // 格位座標 = (x0 + (i mod cols) × dx, y0 + (i div cols) × dy)
    pickGrid: { x0: 40, y0: 40, dx: 42, dy: 42, cols: 3, rows: 4 },
    // 放料盤 3×3 共 9 格,同樣的編號規則
    placeGrid: { x0: 200, y0: 60, dx: 60, dy: 60, cols: 3, rows: 3 },
    tolerance: 6, // 到位判定容差 mm
  },
};
