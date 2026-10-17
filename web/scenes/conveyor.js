import { Scene3D, THREE, MM, COLORS, makeLabel } from './base.js';

const PART_SIZE = 34; // mm

/** 皮帶表面的走向條紋。用貼圖捲動來表現運轉,比轉滾輪省事又直觀 */
function makeBeltTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#5c6674';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#7e8b9b';
  ctx.fillRect(0, 0, 64, 8);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

export class ConveyorScene extends Scene3D {
  constructor(container, scenario) {
    super(container, scenario);
    this.g = scenario.geometry;
    this.partMeshes = new Map();
    this.build();

    this.setFraming(3.0, new THREE.Vector3(0.24, 0.55, 0.8), 6.6);
  }

  /** 模擬座標(mm,皮帶起點為 0)→ 場景座標(皮帶中心為原點) */
  toX(mm) {
    return (mm - this.g.beltLength / 2) * MM;
  }

  build() {
    const g = this.g;
    const beltY = 400; // 皮帶表面離地高度 mm

    const frameMat = this.makeMaterial({ color: COLORS.frame, roughness: 0.7, metalness: 0.3 });
    const darkMat = this.makeMaterial({ color: COLORS.frameDark, roughness: 0.8, metalness: 0.2 });
    const metalMat = this.makeMaterial({ color: COLORS.metal, roughness: 0.35, metalness: 0.85 });

    // ---- 皮帶本體 ----
    this.beltTexture = makeBeltTexture();
    this.beltTexture.repeat.set(g.beltLength / 120, 2);
    this.disposables.push(this.beltTexture);
    const beltMat = this.makeMaterial({ map: this.beltTexture, roughness: 0.9, metalness: 0.05 });

    const belt = this.makeBox(g.beltLength * MM, 30 * MM, g.beltWidth * MM, beltMat);
    belt.position.set(0, beltY * MM, 0);

    // 側邊護欄
    for (const side of [-1, 1]) {
      const rail = this.makeBox(g.beltLength * MM, 60 * MM, 12 * MM, frameMat);
      rail.position.set(0, (beltY + 30) * MM, (side * (g.beltWidth / 2 + 6)) * MM);
    }

    // 支腳
    for (const x of [-0.42, 0.42]) {
      for (const z of [-1, 1]) {
        const leg = this.makeBox(50 * MM, beltY * MM, 50 * MM, darkMat);
        leg.position.set(x * g.beltLength * MM, (beltY / 2) * MM, z * (g.beltWidth / 2 - 30) * MM);
      }
    }

    // 頭尾滾輪
    for (const end of [0, g.beltLength]) {
      const roller = this.makeCylinder(45 * MM, 45 * MM, (g.beltWidth + 20) * MM, metalMat, 20);
      roller.rotation.x = Math.PI / 2;
      roller.position.set(this.toX(end), beltY * MM, 0);
    }

    // ---- 感測器 ----
    this.sensors = {};
    const sensorSpecs = [
      { key: 'sensorEntry', pos: g.posEntry, label: '進料 S1' },
      { key: 'sensorInspect', pos: g.posInspect, label: '檢測 S2' },
      { key: 'sensorExit', pos: g.posExit, label: '出料 S3' },
    ];
    for (const spec of sensorSpecs) {
      const group = new THREE.Group();
      group.position.set(this.toX(spec.pos), 0, -(g.beltWidth / 2 + 45) * MM);
      this.scene.add(group);

      const post = this.makeBox(24 * MM, (beltY + 160) * MM, 24 * MM, darkMat, group);
      post.position.y = ((beltY + 160) / 2) * MM;

      const headMat = this.makeMaterial({ color: 0x7a8798, roughness: 0.5, emissive: 0x000000 });
      const head = this.makeCylinder(20 * MM, 20 * MM, 40 * MM, headMat, 16, group);
      head.rotation.z = Math.PI / 2;
      head.position.set(0, (beltY + 130) * MM, 20 * MM);

      const label = makeLabel(spec.label, { size: 0.34 });
      label.position.set(0, (beltY + 260) * MM, 0);
      group.add(label);
      this.disposables.push(label);

      this.sensors[spec.key] = { headMat };
    }

    // ---- 分料氣缸(裝在皮帶另一側,往 -Z 推)----
    //
    // 幾何以「推頭前緣剛好貼著零件近端」為基準往後推算,推出 stroke 時
    // 推頭前緣才會正好落在零件被推走的位置 — 不然推桿會跟零件脫節。
    //   推頭前緣 z = PART_SIZE/2 - push
    //   推桿(長 stroke)接在推頭後面,缸體再接在推桿全縮回的位置後方
    this.cylBaseZ = PART_SIZE / 2; // 推頭前緣在 push = 0 時的位置
    this.cylinderGroup = new THREE.Group();
    this.cylinderGroup.position.set(this.toX(g.posInspect), (beltY + 15 + PART_SIZE / 2) * MM, 0);
    this.scene.add(this.cylinderGroup);

    const bodyLen = 190;
    // 缸體用深色、推頭用警示橘 — 讓「推出」這個動作在畫面上一眼看得出來
    const cylBodyMat = this.makeMaterial({ color: 0x5f6d80, roughness: 0.35, metalness: 0.8 });
    const cylPadMat = this.makeMaterial({ color: COLORS.warn, roughness: 0.5, metalness: 0.3 });

    const body = this.makeCylinder(38 * MM, 38 * MM, bodyLen * MM, cylBodyMat, 20, this.cylinderGroup);
    body.rotation.x = Math.PI / 2;
    body.position.z = (this.cylBaseZ + 16 + g.cylinderStroke + bodyLen / 2) * MM;

    this.cylRod = this.makeCylinder(14 * MM, 14 * MM, g.cylinderStroke * MM, metalMat, 12, this.cylinderGroup);
    this.cylRod.rotation.x = Math.PI / 2;

    this.cylPad = this.makeBox(70 * MM, 70 * MM, 16 * MM, cylPadMat, this.cylinderGroup);

    // 氣缸支架:少了它缸體看起來像懸空。做細一點,免得擋住皮帶主體
    const cylMount = this.makeBox(55 * MM, (beltY + 60) * MM, 55 * MM, darkMat);
    cylMount.position.set(
      this.toX(g.posInspect),
      ((beltY + 60) / 2) * MM,
      (this.cylBaseZ + 16 + g.cylinderStroke + bodyLen + 20) * MM,
    );

    const cylLabel = makeLabel('分料氣缸 CY1', { size: 0.38 });
    cylLabel.position.set(0, 330 * MM, (this.cylBaseZ + g.cylinderStroke + 200) * MM);
    this.cylinderGroup.add(cylLabel);
    this.disposables.push(cylLabel);

    // ---- 退料槽 ----
    const chuteMat = this.makeMaterial({ color: 0xd6a09a, roughness: 0.85, metalness: 0.1 });
    const chute = this.makeBox(260 * MM, 14 * MM, g.rejectChuteDepth * MM, chuteMat);
    chute.position.set(this.toX(g.posInspect), (beltY - 60) * MM, -(g.beltWidth / 2 + g.rejectChuteDepth / 2) * MM);
    chute.rotation.x = -0.22;

    const chuteLabel = makeLabel('NG 退料槽', { size: 0.38, color: '#b8241a' });
    chuteLabel.position.set(
      this.toX(g.posInspect),
      (beltY + 40) * MM,
      -(g.beltWidth / 2 + g.rejectChuteDepth) * MM,
    );
    this.scene.add(chuteLabel);
    this.disposables.push(chuteLabel);

    // ---- 出料箱 ----
    const binMat = this.makeMaterial({ color: 0x9db4c9, roughness: 0.8, metalness: 0.15 });
    const bin = this.makeBox(300 * MM, 200 * MM, 300 * MM, binMat);
    bin.position.set(this.toX(g.beltLength + 200), 100 * MM, 0);

    const binLabel = makeLabel('OK 出料', { size: 0.38, color: '#0d4a7a' });
    binLabel.position.set(this.toX(g.beltLength + 200), 320 * MM, 0);
    this.scene.add(binLabel);
    this.disposables.push(binLabel);

    // ---- 零件共用的幾何與材質(每個零件都新建會很浪費)----
    this.partGeometry = new THREE.BoxGeometry(PART_SIZE * MM, PART_SIZE * MM, PART_SIZE * MM);
    this.disposables.push(this.partGeometry);
    this.partMatOk = this.makeMaterial({ color: COLORS.partOk, roughness: 0.45, metalness: 0.25 });
    this.partMatNg = this.makeMaterial({ color: COLORS.partNg, roughness: 0.45, metalness: 0.25 });

    this.beltY = beltY;
  }

  update(state) {
    const view = state.engine?.view;
    if (!view) return;
    const g = this.g;

    // ---- 零件:依 id 增刪,不重建整組 ----
    const seen = new Set();
    for (const part of view.parts ?? []) {
      seen.add(part.id);
      let mesh = this.partMeshes.get(part.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.partGeometry, part.ng ? this.partMatNg : this.partMatOk);
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.partMeshes.set(part.id, mesh);
      }
      mesh.position.set(
        this.toX(part.x),
        (this.beltY + 15 + PART_SIZE / 2) * MM,
        -part.lateral * MM,
      );
      // 被推離皮帶後開始往下掉,視覺上才會落進退料槽
      const overhang = part.lateral - g.beltWidth / 2;
      if (overhang > 0) {
        mesh.position.y -= Math.min(overhang * 1.4, 260) * MM;
        mesh.rotation.z = -overhang * 0.006;
      } else {
        mesh.rotation.z = 0;
      }
    }
    for (const [id, mesh] of this.partMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.partMeshes.delete(id);
      }
    }

    // ---- 氣缸推桿:推頭前緣 = cylBaseZ - push,其餘往後排 ----
    const push = (view.cylPos ?? 0) * g.cylinderStroke;
    const padFront = this.cylBaseZ - push;
    this.cylPad.position.z = (padFront + 8) * MM;
    this.cylRod.position.z = (padFront + 16 + g.cylinderStroke / 2) * MM;

    // ---- 感測器指示燈 ----
    const inputs = state.engine?.inputs ?? {};
    for (const [key, sensor] of Object.entries(this.sensors)) {
      // 淺色背景下光暈不明顯,連本體色一起換掉,亮/滅一眼可辨
      const on = Boolean(inputs[key]);
      // S2 是檢測位:亮綠代表判定 OK、亮紅代表 NG。
      // 只看「有沒有亮」分不出好壞,而好壞正是這一站存在的意義。
      const ng = key === 'sensorInspect' && on && inputs.partIsNg;
      sensor.headMat.color.setHex(on ? (ng ? 0xf0483c : 0x16c47f) : 0x7a8798);
      sensor.headMat.emissive.setHex(on ? (ng ? 0xb8241a : 0x0d8a5c) : 0x000000);
      sensor.headMat.emissiveIntensity = on ? 1.6 : 0;
    }

    this.beltDir = view.beltDir ?? 0;
    this.beltSpeed = state.engine?.params?.beltSpeed ?? 200;
  }

  animate(dt) {
    // 皮帶轉動:貼圖捲動方向與速度都跟著實際運轉狀態走
    if (this.beltDir && this.beltTexture) {
      this.beltTexture.offset.x -= (this.beltDir * this.beltSpeed * dt) / 120;
    }
  }

  hud(state) {
    const view = state.engine?.view ?? {};
    const dirText = view.beltFault ? '互鎖異常' : { 1: '正轉 →', '-1': '← 反轉', 0: '停止' }[view.beltDir ?? 0];

    // 檢測結果只在零件停留於感測窗的零點幾秒有效,錯過就看不到了。
    // 沒有零件在位時改顯示上一次的判定,學員才確認得了判別到底有沒有在動作。
    const inspectText = view.inspectNow
      ? `${view.inspectNow} 品`
      : view.lastInspect
        ? `無料(上次 ${view.lastInspect.ng ? 'NG' : 'OK'})`
        : '無料';

    return [
      { key: 'dir', label: '皮帶', value: dirText, alarm: Boolean(view.beltFault) },
      {
        key: 'inspect',
        label: '檢測位 S2',
        value: inspectText,
        alarm: view.inspectNow === 'NG' || (!view.inspectNow && view.lastInspect?.ng),
      },
      { key: 'ok', label: '出料計數', value: String(view.countOk ?? 0) },
      { key: 'ng', label: '退料計數', value: String(view.countNg ?? 0) },
      ...(view.countReturned
        ? [{ key: 'ret', label: '退回進料端', value: String(view.countReturned), alarm: true }]
        : []),
      { key: 'parts', label: '線上零件', value: String(view.parts?.length ?? 0) },
      { key: 'belt', label: '皮帶位移', value: `${(view.beltPos ?? 0).toFixed(0)} mm` },
    ];
  }
}

export default ConveyorScene;
