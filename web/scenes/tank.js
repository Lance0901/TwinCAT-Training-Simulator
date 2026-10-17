import { Scene3D, THREE, MM, COLORS, makeLabel } from './base.js';

const TANK_R = 320; // 槽內半徑 mm
const WALL = 12;
const BASE_Y = 400; // 槽底離地高度 mm

const COLD = new THREE.Color(0x1f9de0);
const HOT = new THREE.Color(0xe03a2c);

/** 閥門與泵:關閉時中性灰藍,全開時飽和綠,中間線性內插 */
const ACTUATOR_OFF = new THREE.Color(0x8895a5);
const ACTUATOR_ON = new THREE.Color(0x16c47f);

export class TankScene extends Scene3D {
  constructor(container, scenario) {
    super(container, scenario);
    this.g = scenario.geometry;
    this.build();

    // 槽體含支腳與攪拌馬達將近 19 units 高,取景中心抓在槽身中段
    this.setFraming(8.2, new THREE.Vector3(0.45, 0.5, 0.74), 8.8);
  }

  build() {
    const g = this.g;
    const H = g.tankHeight;

    const frameMat = this.makeMaterial({ color: COLORS.frame, roughness: 0.6, metalness: 0.4 });
    const darkMat = this.makeMaterial({ color: COLORS.frameDark, roughness: 0.8, metalness: 0.2 });
    const metalMat = this.makeMaterial({ color: COLORS.metal, roughness: 0.28, metalness: 0.9 });

    // ---- 槽體:半透明外殼,才看得到裡面的液位 ----
    const shellMat = this.makeMaterial({
      color: 0x93b0cc,
      roughness: 0.15,
      metalness: 0.4,
      transparent: true,
      opacity: 0.26,
      side: THREE.DoubleSide,
    });
    const shell = this.makeCylinder((TANK_R + WALL) * MM, (TANK_R + WALL) * MM, H * MM, shellMat, 48);
    shell.position.y = (BASE_Y + H / 2) * MM;
    shell.castShadow = false;

    const bottom = this.makeCylinder((TANK_R + WALL) * MM, (TANK_R + WALL) * MM, 20 * MM, metalMat, 48);
    bottom.position.y = (BASE_Y - 10) * MM;

    const rim = this.makeCylinder((TANK_R + WALL + 15) * MM, (TANK_R + WALL + 15) * MM, 24 * MM, frameMat, 48);
    rim.position.y = (BASE_Y + H) * MM;

    // 支腳
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = this.makeBox(45 * MM, BASE_Y * MM, 45 * MM, darkMat);
      leg.position.set(Math.cos(a) * (TANK_R - 20) * MM, (BASE_Y / 2) * MM, Math.sin(a) * (TANK_R - 20) * MM);
    }

    // ---- 液體:高度 1mm 的圓柱,靠 scale.y 拉到實際液位 ----
    this.liquidMat = this.makeMaterial({
      color: COLORS.liquid,
      roughness: 0.25,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
      emissive: 0x000000,
    });
    const liquidGeo = new THREE.CylinderGeometry(TANK_R * MM, TANK_R * MM, MM, 48);
    this.disposables.push(liquidGeo);
    this.liquid = new THREE.Mesh(liquidGeo, this.liquidMat);
    this.scene.add(this.liquid);

    // ---- 液位門檻標記 ----
    const marks = [
      { key: 'highHigh', y: g.thresholds.highHigh, text: 'HH', color: '#b8241a' },
      { key: 'high', y: g.thresholds.high, text: 'H', color: '#8a5800' },
      { key: 'low', y: g.thresholds.low, text: 'L', color: '#8a5800' },
      { key: 'lowLow', y: g.thresholds.lowLow, text: 'LL', color: '#b8241a' },
    ];
    const markMat = new THREE.LineBasicMaterial({ color: 0x445465 });
    this.disposables.push(markMat);
    for (const mark of marks) {
      const pts = [];
      for (let a = 0; a <= 48; a++) {
        const t = (a / 48) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(t) * (TANK_R + WALL + 4) * MM, 0, Math.sin(t) * (TANK_R + WALL + 4) * MM));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      this.disposables.push(geo);
      const ring = new THREE.Line(geo, markMat);
      ring.position.y = (BASE_Y + mark.y) * MM;
      this.scene.add(ring);

      const label = makeLabel(mark.text, { size: 0.35, color: mark.color });
      label.position.set((TANK_R + 190) * MM, (BASE_Y + mark.y) * MM, 0);
      this.scene.add(label);
      this.disposables.push(label);
    }

    // ---- 進料管路 + 閥 ----
    // 走槽體上部的側面進料,而不是拉到槽頂上方 — 拉太高會被相機切出畫面
    const inletY = BASE_Y + H - 90;
    this.inletValveMat = this.makeMaterial({ color: 0x8895a5, roughness: 0.5, metalness: 0.5 });
    const inletPipe = this.makeCylinder(38 * MM, 38 * MM, 700 * MM, metalMat, 16);
    inletPipe.rotation.z = Math.PI / 2;
    inletPipe.position.set(-(TANK_R + 350) * MM, inletY * MM, 0);

    this.inletValve = this.makeBox(90 * MM, 90 * MM, 90 * MM, this.inletValveMat);
    this.inletValve.position.set(-(TANK_R + 420) * MM, inletY * MM, 0);

    this.pumpMat = this.makeMaterial({ color: 0x8895a5, roughness: 0.5, metalness: 0.5 });
    this.pump = this.makeCylinder(80 * MM, 80 * MM, 140 * MM, this.pumpMat, 20);
    this.pump.rotation.z = Math.PI / 2;
    this.pump.position.set(-(TANK_R + 640) * MM, inletY * MM, 0);

    const pumpLabel = makeLabel('進料泵 P1', { size: 0.4, color: '#1f2833' });
    pumpLabel.position.set(-(TANK_R + 560) * MM, (inletY + 170) * MM, 0);
    this.scene.add(pumpLabel);
    this.disposables.push(pumpLabel);

    // ---- 出料管路 + 閥 ----
    this.outletValveMat = this.makeMaterial({ color: 0x8895a5, roughness: 0.5, metalness: 0.5 });
    const outletPipe = this.makeCylinder(34 * MM, 34 * MM, 600 * MM, metalMat, 16);
    outletPipe.rotation.z = Math.PI / 2;
    outletPipe.position.set((TANK_R + 300) * MM, (BASE_Y - 60) * MM, 0);

    this.outletValve = this.makeBox(80 * MM, 80 * MM, 80 * MM, this.outletValveMat);
    this.outletValve.position.set((TANK_R + 420) * MM, (BASE_Y - 60) * MM, 0);

    const outletLabel = makeLabel('出料閥 V2', { size: 0.4, color: '#1f2833' });
    outletLabel.position.set((TANK_R + 420) * MM, (BASE_Y + 100) * MM, 0);
    this.scene.add(outletLabel);
    this.disposables.push(outletLabel);

    // ---- 加熱器:槽底環形電熱管 ----
    this.heaterMat = this.makeMaterial({ color: 0xa8825e, roughness: 0.4, metalness: 0.7, emissive: 0x000000 });
    const heaterGeo = new THREE.TorusGeometry(TANK_R * 0.6 * MM, 18 * MM, 12, 40);
    this.disposables.push(heaterGeo);
    this.heater = new THREE.Mesh(heaterGeo, this.heaterMat);
    this.heater.rotation.x = Math.PI / 2;
    this.heater.position.y = (BASE_Y + 70) * MM;
    this.scene.add(this.heater);

    // ---- 攪拌器 ----
    this.mixer = new THREE.Group();
    this.mixer.position.y = BASE_Y * MM;
    this.scene.add(this.mixer);

    const shaft = this.makeCylinder(22 * MM, 22 * MM, (H + 180) * MM, metalMat, 12, this.mixer);
    shaft.position.y = ((H + 180) / 2) * MM;

    for (let i = 0; i < 3; i++) {
      const blade = this.makeBox(TANK_R * 0.95 * MM, 12 * MM, 70 * MM, metalMat, this.mixer);
      // 葉片放在槽下部,液位一半以下時仍浸在液體裡
      blade.position.y = 150 * MM;
      blade.rotation.y = (i / 3) * Math.PI * 2;
      blade.position.x = Math.cos((i / 3) * Math.PI * 2) * TANK_R * 0.42 * MM;
      blade.position.z = Math.sin((i / 3) * Math.PI * 2) * TANK_R * 0.42 * MM;
    }

    const motor = this.makeBox(160 * MM, 160 * MM, 160 * MM, frameMat, this.mixer);
    motor.position.y = (H + 240) * MM;

    const mixerLabel = makeLabel('攪拌器 M1', { size: 0.42, color: '#1f2833' });
    mixerLabel.position.set(0, (BASE_Y + H + 480) * MM, 0);
    this.scene.add(mixerLabel);
    this.disposables.push(mixerLabel);

    this.mixerAngle = 0;
  }

  update(state) {
    const view = state.engine?.view;
    if (!view) return;
    const g = this.g;

    // ---- 液位 ----
    const level = Math.max(view.level ?? 0, 0.001);
    this.liquid.scale.y = level;
    this.liquid.position.y = (BASE_Y + level / 2) * MM;
    this.liquid.visible = level > 1;

    // ---- 液體顏色隨溫度由藍轉紅 ----
    const t = Math.min(1, Math.max(0, ((view.temperature ?? 20) - 20) / (g.overTempLimit - 20)));
    this.liquidMat.color.copy(COLD).lerp(HOT, t);
    this.liquidMat.emissive.copy(HOT).multiplyScalar(t * 0.25);

    // ---- 加熱器發光正比於功率 ----
    const heat = (view.heaterPower ?? 0) / 100;
    this.heaterMat.emissive.setRGB(heat * 1.0, heat * 0.25, 0);
    this.heaterMat.emissiveIntensity = heat * 2;

    // ---- 閥門與泵:開度用顏色表示 ----
    const inlet = (view.inletValve ?? 0) / 100;
    // 泵沒運轉時閥再開也沒流量,顏色要反映實際有沒有在送料
    const inletActive = view.pumpRun ? inlet : 0;
    this.inletValveMat.color.copy(ACTUATOR_OFF).lerp(ACTUATOR_ON, inletActive);
    this.pumpMat.color.copy(ACTUATOR_OFF).lerp(ACTUATOR_ON, view.pumpRun ? 1 : 0);
    this.outletValveMat.color.copy(ACTUATOR_OFF).lerp(ACTUATOR_ON, (view.outletValve ?? 0) / 100);

    this.mixerRunning = Boolean(view.mixerRun);
  }

  animate(dt) {
    if (this.mixerRunning) {
      this.mixerAngle += dt * 6;
      this.mixer.rotation.y = this.mixerAngle;
    }
  }

  hud(state) {
    const view = state.engine?.view ?? {};
    const alarms = view.alarms ?? {};
    return [
      { key: 'level', label: '液位', value: `${(view.level ?? 0).toFixed(0)} mm  (${(view.levelPercent ?? 0).toFixed(1)} %)`, alarm: alarms.highHigh || alarms.lowLow },
      { key: 'temp', label: '溫度', value: `${(view.temperature ?? 0).toFixed(1)} °C`, alarm: alarms.overTemp },
      { key: 'flow', label: '流量 進/出', value: `${(view.flowIn ?? 0).toFixed(1)} / ${(view.flowOut ?? 0).toFixed(1)} L/min` },
      ...(alarms.dryRun ? [{ key: 'dry', label: '警報', value: '乾燒風險', alarm: true }] : []),
      ...(alarms.overTemp ? [{ key: 'ot', label: '警報', value: '超溫', alarm: true }] : []),
    ];
  }
}

export default TankScene;
