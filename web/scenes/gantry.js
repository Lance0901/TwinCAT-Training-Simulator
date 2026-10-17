import { Scene3D, THREE, MM, COLORS, makeLabel } from './base.js';

const PART_R = 15; // 工件半徑 mm
const PART_H = 20; // 工件高度 mm

/**
 * 吸嘴底端離「台面上表面」的高度。
 *
 * 下限位剛好等於工件高度,吸嘴底才會正好貼在台面工件的頂面上。
 * 上限位不能貼著滑座 —— 桿子若在最高點只剩幾十 mm,會整根縮進滑座裡,
 * 畫面上等於吸嘴消失。留 170 mm 讓桿身在最高點仍看得見 170 mm 以上,
 * 同時抬升高度也遠高於工件的 20 mm,移動時不會擦到已放好的料。
 */
const NOZZLE_UP_OFFSET = 170;
const NOZZLE_DOWN_OFFSET = PART_H;

/** 感測器指示燈:亮紅 = 有感測到,灰 = 沒感測到 */
const SENSOR_ON = 0xe8261a;
const SENSOR_ON_GLOW = 0x9c1710;
const SENSOR_OFF = 0x8896a8;

/** 格位編號 → 座標。取料盤與放料盤共用同一套編號規則,與模擬器端一致 */
function gridPoint(grid, index) {
  return {
    x: grid.x0 + (index % grid.cols) * grid.dx,
    y: grid.y0 + Math.floor(index / grid.cols) * grid.dy,
  };
}

export class GantryScene extends Scene3D {
  constructor(container, scenario) {
    super(container, scenario);
    this.g = scenario.geometry;
    this.placedMeshes = new Map();
    this.droppedMeshes = [];
    this.build();

    // 機構含馬達約 8 m 寬、1 m 高;取景中心抓在龍門中段
    this.setFraming(6.4, new THREE.Vector3(0.5, 0.52, 0.7), 7.4);
  }

  /** 模擬座標(mm,原點在行程左下角)→ 場景座標(工作台中心為原點) */
  toX(mm) {
    return (mm - this.g.strokeX / 2) * MM;
  }

  toZ(mm) {
    return (mm - this.g.strokeY / 2) * MM;
  }

  build() {
    const g = this.g;
    const tableY = 500; // 台面離地高度 mm

    // 立柱與導軌必須離工作區夠遠,否則滑座本體、吸嘴頭走到行程端點時會直接撞上去。
    // Z 方向要多留:那一側除了立柱還要塞下滑座(半深 46)與吸嘴頭(半徑 26)。
    const tableW = g.strokeX + 160;
    const tableD = g.strokeY + 260;

    // 存成實例屬性:撞機時整座龍門要變色示警
    this.frameMat = this.makeMaterial({ color: COLORS.frame, roughness: 0.6, metalness: 0.4 });
    const frameMat = this.frameMat;
    const darkMat = this.makeMaterial({ color: COLORS.frameDark, roughness: 0.8, metalness: 0.2 });
    const metalMat = this.makeMaterial({ color: COLORS.metal, roughness: 0.3, metalness: 0.9 });
    const tableMat = this.makeMaterial({ color: 0xbcc7d4, roughness: 0.85, metalness: 0.1 });

    // ---- 工作台 ----
    const table = this.makeBox(tableW * MM, 40 * MM, tableD * MM, tableMat);
    table.position.y = (tableY - 20) * MM;

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = this.makeBox(50 * MM, tableY * MM, 50 * MM, darkMat);
        leg.position.set((sx * (tableW / 2 - 50)) * MM, (tableY / 2) * MM, (sz * (tableD / 2 - 50)) * MM);
      }
    }
    this.tableTop = tableY;

    // 綠色一律代表「伺服馬達」。兩軸各有一組 馬達 → 聯軸器 → 螺桿 → 螺帽座,
    // 學員看得出來誰在驅動誰;馬達固定在結構上、滑座才是移動件,兩者不會互相穿模。
    const motorMat = this.makeMaterial({ color: COLORS.accent, roughness: 0.45, metalness: 0.45 });
    const couplingMat = this.makeMaterial({ color: 0x2c3542, roughness: 0.6, metalness: 0.5 });

    /** 綠色伺服馬達 + 後端編碼器 + 聯軸器,axis: 'x' 或 'z' */
    const makeServo = (parent, axis, pos, dir) => {
      const rot = axis === 'x' ? Math.PI / 2 : 0;
      const body = this.makeCylinder(48 * MM, 48 * MM, 120 * MM, motorMat, 20, parent);
      const encoder = this.makeCylinder(30 * MM, 30 * MM, 45 * MM, couplingMat, 16, parent);
      const coupling = this.makeCylinder(22 * MM, 22 * MM, 50 * MM, couplingMat, 16, parent);
      for (const m of [body, encoder, coupling]) {
        if (axis === 'x') m.rotation.z = rot;
        else m.rotation.x = Math.PI / 2;
      }
      const place = (m, offset) => {
        const p = { ...pos };
        p[axis] += offset * dir;
        m.position.set(p.x * MM, p.y * MM, p.z * MM);
      };
      place(body, 0);
      place(encoder, 82);
      place(coupling, -85);
      return body;
    };

    // ---- X 軸傳動 ----
    //
    // 單邊驅動的龍門:螺桿必須與被推的那根立柱在同一條線上,螺帽座直接鎖在柱底。
    // 螺桿擺在兩柱中間看起來像推空氣,受力路徑也講不通。
    // 另一側只有線性導軌當從動,這正是實機會產生龍門扭轉的原因。
    const railZ = tableD / 2 - 26; // 兩側導軌 / 立柱的中心線
    const railY = tableY + 12;
    const railTop = railY + 12;
    const columnBottom = tableY + 95;
    // 滑座塊要從導軌頂一路頂到立柱底,中間留空隙的話整根龍門看起來就是浮的
    const blockY = (railTop + columnBottom) / 2;
    const blockH = columnBottom - railTop;
    const baseY = blockY; // X 螺桿穿過滑座塊的中心

    for (const sz of [-1, 1]) {
      const rail = this.makeBox((g.strokeX + 120) * MM, 24 * MM, 36 * MM, metalMat);
      rail.position.set(0, railY * MM, (sz * railZ) * MM);
    }

    const xScrewZ = -railZ; // 驅動側:與該側立柱同一條中心線
    // 螺桿要比行程長:門架走到 X=0 時滑座塊的外緣在 -250,聯軸器必須讓在那之外,
    // 螺桿也得跟著伸長到聯軸器裡,否則兩者中間會浮出一段空隙。
    const xTravelEdge = g.strokeX / 2 + 50; // 滑座塊在行程端點的外緣 = 250
    const xMotorX = -(xTravelEdge + 135);
    const xScrewLen = 2 * (xTravelEdge + 60);
    const xScrew = this.makeCylinder(15 * MM, 15 * MM, xScrewLen * MM, metalMat, 16);
    xScrew.rotation.z = Math.PI / 2;
    xScrew.position.set(0, baseY * MM, xScrewZ * MM);

    makeServo(this.scene, 'x', { x: xMotorX, y: baseY, z: xScrewZ }, -1);

    // 馬達架:少了它,馬達會整顆懸在台面外
    const motorMountH = baseY - 48;
    const motorMount = this.makeBox(90 * MM, motorMountH * MM, 90 * MM, darkMat);
    motorMount.position.set(xMotorX * MM, (motorMountH / 2) * MM, xScrewZ * MM);

    const xMotorLabel = makeLabel('X 軸伺服', { size: 0.36, color: '#07694a' });
    xMotorLabel.position.set(xMotorX * MM, (baseY + 130) * MM, xScrewZ * MM);
    this.scene.add(xMotorLabel);
    this.disposables.push(xMotorLabel);

    // ---- 門架:沿 X 移動 ----
    this.bridge = new THREE.Group();
    this.scene.add(this.bridge);

    const columnH = 360;
    const columnTop = columnBottom + columnH;

    for (const sz of [-1, 1]) {
      const column = this.makeBox(60 * MM, columnH * MM, 60 * MM, frameMat, this.bridge);
      column.position.set(0, (columnBottom + columnH / 2) * MM, (sz * railZ) * MM);
    }

    // 兩側各一塊滑座:下緣坐在導軌頂、上緣頂住立柱底,把台面到龍門的受力路徑接起來。
    // 驅動側的滑座同時是螺帽座 —— X 螺桿從它中間穿過去,動力就是從這裡傳進龍門的。
    for (const sz of [-1, 1]) {
      const block = this.makeBox(100 * MM, blockH * MM, 96 * MM, metalMat, this.bridge);
      block.position.set(0, blockY * MM, (sz * railZ) * MM);
    }

    const beamY = columnTop + 35;
    const beam = this.makeBox(70 * MM, 70 * MM, tableD * MM, frameMat, this.bridge);
    beam.position.set(0, beamY * MM, 0);

    // ---- Y 軸傳動:螺桿掛在橫樑下方,馬達裝在橫樑一端(跟著門架走)----
    //
    // 螺桿一定會跨過立柱所在的位置才接得到外側的馬達。實機是在立柱上裝軸承座、
    // 螺桿從軸承孔穿過去,所以這裡也放一個包住立柱的軸承座 —— 少了它,
    // 畫面上就是一根圓柱憑空插進方柱裡。
    const yScrewY = columnTop - 40;
    const bearingZ = railZ;
    const bearingDepth = 90;
    const bearingOuter = bearingZ + bearingDepth / 2;

    const bearing = this.makeBox(90 * MM, 80 * MM, bearingDepth * MM, metalMat, this.bridge);
    bearing.position.set(0, yScrewY * MM, bearingZ * MM);

    const yScrewZ0 = -(railZ - 50); // 內側端點,停在立柱之前
    const yScrewZ1 = bearingOuter + 30; // 外側伸出軸承座,好讓聯軸器套住
    const yScrewLen = yScrewZ1 - yScrewZ0;
    const yScrew = this.makeCylinder(13 * MM, 13 * MM, yScrewLen * MM, metalMat, 16, this.bridge);
    yScrew.rotation.x = Math.PI / 2;
    yScrew.position.set(0, yScrewY * MM, ((yScrewZ0 + yScrewZ1) / 2) * MM);

    // 聯軸器套住螺桿末端,馬達再接在聯軸器外側
    const yMotorZ = yScrewZ1 + 75;
    makeServo(this.bridge, 'z', { x: 0, y: yScrewY, z: yMotorZ }, 1);

    // 從軸承座伸到馬達的托架。刻意壓在螺桿下方托住馬達,
    // 跟螺桿同高的話等於一根桿子從托架中間穿過去。
    const bracketZ0 = bearingOuter;
    const bracketZ1 = yMotorZ - 60;
    const yBracket = this.makeBox(84 * MM, 40 * MM, (bracketZ1 - bracketZ0) * MM, frameMat, this.bridge);
    yBracket.position.set(0, (yScrewY - 40) * MM, ((bracketZ0 + bracketZ1) / 2) * MM);

    const yMotorLabel = makeLabel('Y 軸伺服', { size: 0.36, color: '#07694a' });
    yMotorLabel.position.set(0, (yScrewY + 130) * MM, yMotorZ * MM);
    this.bridge.add(yMotorLabel);
    this.disposables.push(yMotorLabel);

    // ---- 滑座:騎在 Y 螺桿上,沿 Z(模擬座標的 Y 軸)移動 ----
    this.carriage = new THREE.Group();
    this.bridge.add(this.carriage);

    // 螺帽座包住螺桿,中心與螺桿同高 —— 橫樑底在 beamY-35,不會互相嵌入
    const carriageBody = this.makeBox(92 * MM, 72 * MM, 92 * MM, metalMat, this.carriage);
    carriageBody.position.y = yScrewY * MM;
    /** 滑座底面的絕對高度 —— 吸嘴桿的上端永遠固定在這裡 */
    this.carriageBottom = yScrewY - 36;

    // ---- 吸嘴:掛在滑座下,沿 Y 升降 ----
    //
    // 桿子必須「伸縮」而不是整根平移:固定長度的桿子在下降時會與滑座脫開,
    // 上升時又會從橫樑頂端穿出去。所以這裡用單位長度的圓柱靠 scale.y 拉伸,
    // 上端釘在滑座底面、下端跟著吸嘴頭走,兩端永遠接得上。
    //
    // 這些件直接掛在 carriage 底下(carriage 只做 X/Z 平移,y 保持 0),
    // 所以它們的 position.y 就是絕對高度,不必再換算。
    // 場景配色是有分工的:綠 = 伺服馬達、藍 = 工件、灰 = 機架結構。
    // 吸嘴是唯一會上下動作的執行件,給它橘色才不會跟前三者混在一起。
    this.nozzleMat = this.makeMaterial({ color: 0xff7a1a, roughness: 0.4, metalness: 0.35 });

    const shaftGeo = new THREE.CylinderGeometry(15 * MM, 15 * MM, MM, 16);
    this.disposables.push(shaftGeo);
    this.nozzleShaft = new THREE.Mesh(shaftGeo, this.nozzleMat);
    this.nozzleShaft.castShadow = true;
    this.carriage.add(this.nozzleShaft);

    this.nozzleHead = this.makeCylinder(9 * MM, 22 * MM, 34 * MM, this.nozzleMat, 16, this.carriage);

    // ---- 取料盤 ----
    // 托板嵌進台面、頂面與台面齊平,取料位的工件才會跟放料格位的工件同高,
    // 吸嘴同一個下限位對兩邊都剛好貼合。把托板墊高會讓工件陷進托板裡,
    // 所以改用四周的細邊框標示範圍。
    const pickCount = g.pickGrid.cols * g.pickGrid.rows;
    const slots = Array.from({ length: pickCount }, (_, i) => gridPoint(g.pickGrid, i));
    const slotMaxX = slots.at(-1).x;
    const slotMaxY = slots.at(-1).y;
    const trayCx = (slots[0].x + slotMaxX) / 2;
    const trayCy = (slots[0].y + slotMaxY) / 2;
    const trayW = slotMaxX - slots[0].x + 56;
    const trayD = slotMaxY - slots[0].y + 56;

    this.pickTray = new THREE.Group();
    this.pickTray.position.set(this.toX(trayCx), tableY * MM, this.toZ(trayCy));
    this.scene.add(this.pickTray);

    const trayMat = this.makeMaterial({ color: 0x5b6d80, roughness: 0.8, metalness: 0.2 });
    const trayBase = this.makeBox(trayW * MM, 14 * MM, trayD * MM, trayMat, this.pickTray);
    trayBase.position.y = -7 * MM;

    const halfW = trayW / 2;
    const halfD = trayD / 2;
    for (const [dx, dz, w, d] of [
      [0, -halfD, trayW + 10, 10],
      [0, halfD, trayW + 10, 10],
      [-halfW, 0, 10, trayD + 10],
      [halfW, 0, 10, trayD + 10],
    ]) {
      const bar = this.makeBox(w * MM, 8 * MM, d * MM, trayMat, this.pickTray);
      bar.position.set(dx * MM, 4 * MM, dz * MM);
    }

    const pickLabel = makeLabel('取料盤', { size: 0.4, color: '#07694a' });
    pickLabel.position.set(0, 150 * MM, 0);
    this.pickTray.add(pickLabel);
    this.disposables.push(pickLabel);

    // ---- 工件共用資源 ----
    this.partGeometry = new THREE.CylinderGeometry(PART_R * MM, PART_R * MM, PART_H * MM, 20);
    this.disposables.push(this.partGeometry);
    this.partMat = this.makeMaterial({ color: COLORS.partOk, roughness: 0.4, metalness: 0.3 });
    this.partMatDropped = this.makeMaterial({ color: COLORS.danger, roughness: 0.6, metalness: 0.2 });

    // 取料盤上的料:每個格位各一顆,平鋪在台面上。
    // 消耗順序與模型一致 —— 從第 0 格往後取,取走哪一格就是哪一格消失。
    this.trayParts = slots.map((slot) => {
      const mesh = new THREE.Mesh(this.partGeometry, this.partMat);
      mesh.castShadow = true;
      mesh.position.set(
        (slot.x - trayCx) * MM,
        (PART_H / 2) * MM,
        (slot.y - trayCy) * MM,
      );
      this.pickTray.add(mesh);
      return mesh;
    });

    // 吸嘴上吸著的工件
    this.heldPart = new THREE.Mesh(this.partGeometry, this.partMat);
    this.heldPart.castShadow = true;
    this.heldPart.visible = false;
    this.carriage.add(this.heldPart);

    // ---- 放料格位標記 ----
    const gridMat = new THREE.LineBasicMaterial({ color: 0x39485a });
    this.disposables.push(gridMat);
    for (let i = 0; i < g.placeGrid.cols * g.placeGrid.rows; i++) {
      const c = this.cellCenter(i);
      const points = [];
      const r = 26;
      for (let a = 0; a <= 24; a++) {
        const t = (a / 24) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(t) * r * MM, 0, Math.sin(t) * r * MM));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      this.disposables.push(geo);
      const ring = new THREE.Line(geo, gridMat);
      ring.position.set(this.toX(c.x), (tableY + 2) * MM, this.toZ(c.y));
      this.scene.add(ring);
    }

    // ---- NC 命令位置的「幽靈」標記 ----
    // 撞機時 NC 以為自己還在往前跑,機構卻卡在擋塊上。把 NC 的 ActPos 畫成一個
    // 紅色十字,學員就看得到「控制器認為的位置」與「機器真正的位置」差多遠。
    const ghostMat = new THREE.LineBasicMaterial({ color: 0xd0281f });
    this.disposables.push(ghostMat);
    const ghostPts = [];
    const arm = 45;
    ghostPts.push(new THREE.Vector3(-arm * MM, 0, 0), new THREE.Vector3(arm * MM, 0, 0));
    ghostPts.push(new THREE.Vector3(0, 0, -arm * MM), new THREE.Vector3(0, 0, arm * MM));
    const ghostGeo = new THREE.BufferGeometry().setFromPoints(ghostPts);
    this.disposables.push(ghostGeo);
    this.ncGhost = new THREE.LineSegments(ghostGeo, ghostMat);
    this.ncGhost.visible = false;
    this.scene.add(this.ncGhost);

    // ---- 撞擊點標記 ----
    this.impactMat = this.makeMaterial({
      color: 0xd0281f,
      emissive: 0x8a1b14,
      roughness: 0.5,
      transparent: true,
      opacity: 0.85,
    });
    this.impactGeo = new THREE.SphereGeometry(22 * MM, 12, 10);
    this.disposables.push(this.impactGeo);
    this.impactMeshes = [];

    // ---- 感測器指示燈 ----
    //
    // 每個訊號都在機構上有對應的實體位置,亮紅 = 有感測到、灰 = 沒感測到。
    // 學員照著畫面就能對上 I/O 表裡的每一個 bit,不必憑空想像它裝在哪。
    this.sensors = {};
    this.sensorGeo = new THREE.SphereGeometry(13 * MM, 14, 12);
    this.disposables.push(this.sensorGeo);

    /** parent 給 this.bridge / this.carriage 就會跟著機構移動 */
    const addSensor = (key, label, pos, parent = this.scene, labelColor = '#4d5a68') => {
      const mat = this.makeMaterial({ color: SENSOR_OFF, roughness: 0.35, metalness: 0.2, emissive: 0x000000 });
      const mesh = new THREE.Mesh(this.sensorGeo, mat);
      mesh.castShadow = true;
      mesh.position.set(pos.x * MM, pos.y * MM, pos.z * MM);
      parent.add(mesh);

      // 感測器本體:一小截支架,免得指示燈看起來浮在半空
      const stem = this.makeBox(10 * MM, 10 * MM, 10 * MM, metalMat, parent);
      stem.position.copy(mesh.position);

      const tag = makeLabel(label, { size: 0.26, color: labelColor });
      tag.position.set(pos.x * MM, (pos.y + 42) * MM, pos.z * MM);
      parent.add(tag);
      this.disposables.push(tag);

      this.sensors[key] = { mat, mesh, stem, tag };
      return this.sensors[key];
    };

    // X 軸:原點與兩端硬體極限,裝在從動側導軌外緣(固定不動)。
    // 刻意放在靠觀看者這一側 —— 擺到驅動側的話會被龍門與螺桿整個擋住。
    const xSensY = railTop + 20;
    const xSensZ = railZ + 46;
    addSensor('limitXNeg', 'X−極限', { x: this.toX(0) / MM, y: xSensY, z: xSensZ });
    addSensor('homeX', 'X原點', { x: this.toX(40) / MM, y: xSensY, z: xSensZ });
    addSensor('limitXPos', 'X+極限', { x: this.toX(g.strokeX) / MM, y: xSensY, z: xSensZ });

    // Y 軸:裝在橫樑上,跟著門架一起移動
    const ySensY = yScrewY + 46;
    addSensor('limitYNeg', 'Y−極限', { x: 0, y: ySensY, z: this.toZ(0) / MM }, this.bridge);
    addSensor('homeY', 'Y原點', { x: 0, y: ySensY, z: this.toZ(34) / MM }, this.bridge);
    addSensor('limitYPos', 'Y+極限', { x: 0, y: ySensY, z: this.toZ(g.strokeY) / MM }, this.bridge);

    // 吸嘴升降限位:裝在滑座上,跟著 X/Y 走
    addSensor('nozzleIsUp', '吸嘴上限', { x: 56, y: this.carriageBottom - 24, z: 0 }, this.carriage);
    addSensor('nozzleIsDown', '吸嘴下限', { x: 56, y: this.carriageBottom - 86, z: 0 }, this.carriage);

    // 真空確認:裝在吸嘴頭旁,會跟著吸嘴升降,實際高度在 update 裡每幀跟上
    this.vacuumSensor = addSensor('partHeld', '真空確認', { x: -52, y: 0, z: 0 }, this.carriage, '#b8241a');

    // 取料盤有料
    addSensor('partAtPick', '取料盤有料', { x: 0, y: 70, z: -(trayD / 2 + 34) }, this.pickTray, '#07694a');

    const placeLabel = makeLabel('放料盤 3×3', { size: 0.45, color: '#0d4a7a' });
    placeLabel.position.set(
      this.toX(g.placeGrid.x0 + g.placeGrid.dx),
      (tableY + 200) * MM,
      this.toZ(g.placeGrid.y0 - 60),
    );
    this.scene.add(placeLabel);
    this.disposables.push(placeLabel);
  }

  cellCenter(index) {
    return gridPoint(this.g.placeGrid, index);
  }

  update(state) {
    const view = state.engine?.view;
    if (!view) return;
    const g = this.g;

    // ---- 軸位置:機構跟隨 NC 回報的實際位置(已被機械行程夾住)----
    this.bridge.position.x = this.toX(view.x ?? 0);
    this.carriage.position.z = this.toZ(view.y ?? 0);

    // ---- NC 命令位置的幽靈標記 ----
    const dx = (view.ncX ?? 0) - (view.x ?? 0);
    const dy = (view.ncY ?? 0) - (view.y ?? 0);
    const drift = Math.max(Math.abs(dx), Math.abs(dy));
    this.ncGhost.visible = drift > 1;
    if (this.ncGhost.visible) {
      this.ncGhost.position.set(this.toX(view.ncX ?? 0), (this.tableTop + 6) * MM, this.toZ(view.ncY ?? 0));
    }

    // ---- 撞擊點 ----
    const impacts = view.impactPoints ?? [];
    while (this.impactMeshes.length > impacts.length) {
      const m = this.impactMeshes.pop();
      this.scene.remove(m);
    }
    impacts.forEach((p, i) => {
      let mesh = this.impactMeshes[i];
      if (!mesh) {
        mesh = new THREE.Mesh(this.impactGeo, this.impactMat);
        this.scene.add(mesh);
        this.impactMeshes[i] = mesh;
      }
      mesh.position.set(this.toX(p.x), (this.tableTop + 30) * MM, this.toZ(p.y));
    });

    this.collision = Boolean(view.collision);
    this.homingRequired = Boolean(view.homingRequired);
    // 三種狀態要分得開:撞擊中閃紅、已確認但未復歸恆亮琥珀、正常則原色。
    // 恢復顏色放在這裡而不是只放在 animate:分頁切到背景時 render loop 會停,
    // 光靠 animate 的話狀態變了顏色還留在原處。
    if (!this.collision) {
      this.frameMat.color.setHex(this.homingRequired ? 0xc98a1e : COLORS.frame);
    }

    // ---- 吸嘴升降:nozzle 0 = 上限位,1 = 下限位 ----
    const t = view.nozzle ?? 0;
    // 吸嘴底端的絕對高度
    const bottom = this.tableTop + NOZZLE_UP_OFFSET + (NOZZLE_DOWN_OFFSET - NOZZLE_UP_OFFSET) * t;

    // 桿子上端釘在滑座底、下端接吸嘴頭,長度隨行程伸縮 —— 兩端永遠不脫節
    const shaftLen = Math.max(1, this.carriageBottom - bottom);
    this.nozzleShaft.scale.y = shaftLen;
    this.nozzleShaft.position.y = (bottom + shaftLen / 2) * MM;
    this.nozzleHead.position.y = (bottom + 17) * MM;

    // 真空確認感測器裝在吸嘴頭上,跟著升降一起走
    for (const part of [this.vacuumSensor.mesh, this.vacuumSensor.stem]) {
      part.position.y = (bottom + 30) * MM;
    }
    this.vacuumSensor.tag.position.y = (bottom + 72) * MM;

    // ---- 感測器指示燈:有感測到亮紅,沒感測到維持灰色 ----
    const inputs = state.engine?.inputs ?? {};
    for (const [key, sensor] of Object.entries(this.sensors)) {
      const on = Boolean(inputs[key]);
      sensor.mat.color.setHex(on ? SENSOR_ON : SENSOR_OFF);
      sensor.mat.emissive.setHex(on ? SENSOR_ON_GLOW : 0x000000);
      sensor.mat.emissiveIntensity = on ? 1.8 : 0;
    }

    // ---- 手上的工件:貼在吸嘴底下 ----
    this.heldPart.visible = Boolean(view.holding);
    this.heldPart.position.y = (bottom - PART_H / 2) * MM;

    // ---- 取料盤:已取走的格位空著,從第 0 格往後消耗 ----
    const nextPick = view.nextPickIndex ?? 0;
    this.trayParts.forEach((mesh, i) => {
      mesh.visible = nextPick >= 0 && i >= nextPick;
    });

    // ---- 已放好的工件 ----
    const placed = new Set(view.placed ?? []);
    for (const index of placed) {
      if (this.placedMeshes.has(index)) continue;
      const c = this.cellCenter(index);
      const mesh = new THREE.Mesh(this.partGeometry, this.partMat);
      mesh.castShadow = true;
      mesh.position.set(this.toX(c.x), (this.tableTop + PART_H / 2) * MM, this.toZ(c.y));
      this.scene.add(mesh);
      this.placedMeshes.set(index, mesh);
    }
    for (const [index, mesh] of this.placedMeshes) {
      if (!placed.has(index)) {
        this.scene.remove(mesh);
        this.placedMeshes.delete(index);
      }
    }

    // ---- 掉件:放在掉落當下的座標,提醒學員順序寫錯了 ----
    const dropped = view.dropped ?? [];
    while (this.droppedMeshes.length > dropped.length) {
      this.scene.remove(this.droppedMeshes.pop());
    }
    dropped.forEach((d, i) => {
      let mesh = this.droppedMeshes[i];
      if (!mesh) {
        mesh = new THREE.Mesh(this.partGeometry, this.partMatDropped);
        mesh.castShadow = true;
        mesh.rotation.z = Math.PI / 2; // 躺倒表示掉落
        this.scene.add(mesh);
        this.droppedMeshes[i] = mesh;
      }
      mesh.position.set(this.toX(d.x), (this.tableTop + PART_R) * MM, this.toZ(d.y));
    });
  }

  /** 撞機時整座龍門閃紅,滑鼠沒盯著側欄也看得到 */
  animate(dt) {
    this.blink = (this.blink ?? 0) + dt;
    if (this.collision) {
      const pulse = 0.5 + 0.5 * Math.sin(this.blink * 9);
      this.frameMat.color.setRGB(0.55 + pulse * 0.3, 0.18 + pulse * 0.05, 0.14 + pulse * 0.05);
      this.impactMat.opacity = 0.5 + pulse * 0.45;
    }
  }

  hud(state) {
    const view = state.engine?.view ?? {};
    const axisName = { 1: 'X 軸', 2: 'Y 軸', 3: 'X + Y 軸' }[view.collisionAxis] ?? '';

    return [
      ...(view.collision
        ? [
            {
              key: 'crash',
              label: '碰撞',
              value: `${axisName}撞上機械擋塊(${(view.impactSpeed ?? 0).toFixed(0)} mm/s)`,
              alarm: true,
            },
          ]
        : []),
      // 警報確認後仍要提醒座標不可信,直到機構真的開回原點
      ...(view.homingRequired && !view.collision
        ? [{ key: 'rehome', label: '待復歸', value: '座標不可信,請開回原點', alarm: true }]
        : []),
      { key: 'nc', label: 'NC 以為', value: `${(view.ncX ?? 0).toFixed(1)} / ${(view.ncY ?? 0).toFixed(1)} mm` },
      {
        key: 'mach',
        label: '機構實際',
        value: `${(view.x ?? 0).toFixed(1)} / ${(view.y ?? 0).toFixed(1)} mm`,
        alarm: view.collision,
      },
      // 增量與機械縮放是撞機的根源,直接攤在畫面上
      ...(view.usingInc
        ? [
            { key: 'inc', label: '收到增量', value: `${view.incX ?? 0} / ${view.incY ?? 0} inc` },
            {
              key: 'scale',
              label: '機械縮放',
              value: `${((view.mmPerInc ?? 0) * 1e6).toFixed(3)} µm/inc`,
            },
          ]
        : []),
      ...((view.followError ?? 0) > 0.5
        ? [
            {
              key: 'ferr',
              label: '跟隨誤差',
              value: `${(view.followError ?? 0).toFixed(1)} mm`,
              alarm: true,
            },
          ]
        : []),
      {
        key: 'tray',
        label: '取料盤',
        value:
          (view.nextPickIndex ?? -1) >= 0
            ? `剩 ${view.trayRemaining ?? 0} 顆,下一顆在第 ${view.nextPickIndex} 格`
            : '已取完',
      },
      { key: 'placed', label: '已放料', value: `${view.countPlaced ?? 0} / 9` },
      ...(view.dropped?.length
        ? [{ key: 'drop', label: '掉件', value: String(view.dropped.length), alarm: true }]
        : []),
    ];
  }
}

export default GantryScene;
