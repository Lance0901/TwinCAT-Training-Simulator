import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** 模型全部用 mm 思考,再統一縮到 Three.js 單位 — 1 unit = 100 mm */
export const MM = 0.01;

/**
 * 淺色場景用的配色。
 *
 * 機構件保持中明度的藍灰(太亮會跟白底糊在一起、太暗又顯得髒),
 * 工件與致動器則用高飽和色,讓「會動的東西」在畫面上第一眼就跳出來。
 */
export const COLORS = {
  frame: 0x8896a8,
  frameDark: 0x66748a,
  belt: 0x5c6674,
  metal: 0xc3ccd8,
  accent: 0x0d8a5c,
  accentDim: 0x0a6845,
  warn: 0xe09000,
  danger: 0xe03a2c,
  partOk: 0x1a7fd4,
  partNg: 0xe03a2c,
  liquid: 0x1f9de0,
  hot: 0xe03a2c,
};

const BACKGROUND = 0xe7ecf2;

/**
 * 所有 3D 場景的共同底座:renderer、相機、燈光、地板、動畫迴圈、資源釋放。
 *
 * 子類別實作 build() 建立幾何,並實作 update(state) 每幀同步模擬狀態。
 */
export class Scene3D {
  constructor(container, scenario) {
    this.container = container;
    this.scenario = scenario;
    this.disposables = [];
    this.running = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND);
    // 霧氣只用來柔化遠處的地板格線,起點拉遠避免機台本身被沖淡
    this.scene.fog = new THREE.Fog(BACKGROUND, 28, 70);

    const { clientWidth: w, clientHeight: h } = container;
    this.camera = new THREE.PerspectiveCamera(45, (w || 1) / (h || 1), 0.1, 200);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w || 1, h || 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.append(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49; // 不讓相機鑽到地板下面

    this.addLights();
    this.addGround();

    this.lastW = 0;
    this.lastH = 0;
    this.clock = new THREE.Clock();
  }

  addLights() {
    // 天空光偏白、地面反射光也保持明亮,背光面才不會沉成一團灰
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c6d4, 2.0));

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(8, 14, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const d = 14;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    key.shadow.camera.far = 50;
    key.shadow.bias = -0.0015;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xdce6f2, 1.0);
    fill.position.set(-9, 6, -7);
    this.scene.add(fill);
  }

  addGround() {
    const grid = new THREE.GridHelper(60, 60, 0x8b98a8, 0xc2cbd6);
    grid.position.y = -0.01;
    this.scene.add(grid);
    this.disposables.push(grid);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0xdae1e9, roughness: 0.95, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.track(ground);
  }

  /** 登記需要手動釋放的資源 */
  track(...objects) {
    this.disposables.push(...objects);
    return objects[0];
  }

  makeMaterial(options) {
    const material = new THREE.MeshStandardMaterial(options);
    this.disposables.push(material);
    return material;
  }

  makeBox(w, h, d, material, parent = this.scene) {
    const geometry = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.disposables.push(geometry);
    return mesh;
  }

  makeCylinder(rTop, rBottom, h, material, segments = 24, parent = this.scene) {
    const geometry = new THREE.CylinderGeometry(rTop, rBottom, h, segments);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.disposables.push(geometry);
    return mesh;
  }

  /**
   * 每幀比對容器尺寸。
   *
   * 原本用 ResizeObserver,但場景是在 WebSocket 收到第一筆狀態時才建立的,
   * 容器當下的尺寸不一定已經定案,而之後容器尺寸不再變動就等不到回呼,
   * canvas 會永遠停在建構當下的錯誤尺寸。在 rAF 開頭讀 clientWidth 時
   * 瀏覽器剛做完 layout,成本很低,換來的是不管何時建立都一定對得上。
   */
  syncSize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h || (w === this.lastW && h === this.lastH)) return;
    this.lastW = w;
    this.lastH = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.fitView();
  }

  /**
   * 設定取景:看向 (0, targetY, 0),從 dir 方向、退到剛好框住半徑 radius 的距離。
   *
   * 直接寫死相機座標在寬螢幕上沒問題,但視窗一窄、側欄改成上下排列時,
   * 3D 區會變成很扁的長方形,垂直視野跟著縮水,高一點的機構就被切掉。
   * 所以距離改成從 fov 與實際 aspect 推算。
   */
  setFraming(targetY, dir, radius) {
    this.framing = { targetY, dir: dir.clone().normalize(), radius };
    this.controls.target.set(0, targetY, 0);
    this.camera.position.copy(this.framing.dir).add(this.controls.target);
    this.controls.update();
    this.fitView(true);
  }

  fitView(force = false) {
    if (!this.framing) return;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const half = Math.tan(vFov / 2);
    // 取垂直與水平兩個方向所需距離的較大者,兩軸都框得住
    const need =
      Math.max(this.framing.radius / half, this.framing.radius / (half * Math.max(this.camera.aspect, 0.01))) * 1.06;

    const offset = this.camera.position.clone().sub(this.controls.target);
    if (!force && offset.lengthSq() < 1e-6) return;
    this.camera.position.copy(this.controls.target).add(offset.setLength(need));
    this.controls.update();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frameId = requestAnimationFrame(loop);
      this.syncSize();
      const dt = this.clock.getDelta();
      this.controls.update();
      this.animate?.(dt);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.frameId) cancelAnimationFrame(this.frameId);
  }

  /** 子類別覆寫:把模擬狀態同步到幾何 */
  update() {}

  dispose() {
    this.stop();
    this.controls.dispose();
    for (const item of this.disposables) {
      item.userData?.dispose?.(); // 標示牌的 canvas 貼圖走這條
      item.dispose?.();
    }
    this.disposables = [];
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.scene.clear();
  }
}

/**
 * 把文字畫成貼圖做成標示牌。
 * 純幾何場景很難分辨哪裡是取料位、哪個是進料感測器,加上標籤學員才對得起來。
 */
export function makeLabel(text, { color = '#1f2833', size = 0.6 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 68px "Segoe UI", "Microsoft JhengHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 白色描邊讓標籤壓在深色機構件上也讀得清楚
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeText(text, 256, 64);
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(size * 4, size, 1);
  sprite.userData.dispose = () => {
    texture.dispose();
    material.dispose();
  };
  return sprite;
}

export { THREE };
