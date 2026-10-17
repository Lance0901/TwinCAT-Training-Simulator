import ConveyorScene from './conveyor.js';
import GantryScene from './gantry.js';
import TankScene from './tank.js';

const SCENE_CLASSES = {
  conveyor: ConveyorScene,
  gantry: GantryScene,
  tank: TankScene,
};

/**
 * 管理當前的 3D 場景:切換場景時徹底釋放舊的 WebGL 資源。
 * 不釋放的話每切一次就多留一個 renderer 和一批 GPU buffer,幾次之後就會卡。
 */
export class SceneHost {
  constructor(container, hud) {
    this.container = container;
    this.hud = hud;
    this.current = null;
    this.currentId = null;
  }

  load(scenario) {
    if (this.currentId === scenario.id) return;
    this.dispose();

    const SceneClass = SCENE_CLASSES[scenario.id];
    if (!SceneClass) {
      this.container.innerHTML = `<p style="padding:24px;color:#4d5a68">場景「${scenario.id}」尚無 3D 視圖。</p>`;
      this.currentId = scenario.id;
      return;
    }

    this.current = new SceneClass(this.container, scenario);
    this.current.start();
    this.currentId = scenario.id;
  }

  update(state) {
    if (!this.current) return;
    this.current.update(state);
    if (this.current.hud) this.hud.set(this.current.hud(state));
  }

  dispose() {
    if (this.current) {
      this.current.dispose();
      this.current = null;
    }
    this.container.innerHTML = '';
    this.hud.clear();
    this.currentId = null;
  }
}

export default SceneHost;
