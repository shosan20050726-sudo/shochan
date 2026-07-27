import CFG from './Config.js';

/**
 * Pointer-lock mouse look plus action mapping. Exposes both edge-triggered
 * (`pressed`) and level-triggered (`down`) queries because movement wants
 * "is held" while weapons want "was tapped this frame".
 */
export const ACTION = {
  FORWARD: 'forward', BACK: 'back', LEFT: 'left', RIGHT: 'right',
  JUMP: 'jump', CROUCH: 'crouch', SPRINT: 'sprint',
  FIRE: 'fire', ADS: 'ads', RELOAD: 'reload', USE: 'use', MELEE: 'melee',
  TACTICAL: 'tactical', ULTIMATE: 'ultimate', PING: 'ping',
  SLOT1: 'slot1', SLOT2: 'slot2', MAP: 'map',
};

const DEFAULT_BINDINGS = {
  KeyW: ACTION.FORWARD, KeyS: ACTION.BACK, KeyA: ACTION.LEFT, KeyD: ACTION.RIGHT,
  Space: ACTION.JUMP, ControlLeft: ACTION.CROUCH, KeyC: ACTION.CROUCH,
  ShiftLeft: ACTION.SPRINT, KeyR: ACTION.RELOAD, KeyE: ACTION.USE,
  KeyV: ACTION.MELEE, KeyQ: ACTION.TACTICAL, KeyZ: ACTION.ULTIMATE,
  Digit1: ACTION.SLOT1, Digit2: ACTION.SLOT2, KeyM: ACTION.MAP,
};
const MOUSE_BINDINGS = { 0: ACTION.FIRE, 1: ACTION.ADS, 2: ACTION.PING };

export class Input {
  constructor(canvas, bus) {
    this.name = 'input';
    this.priority = 0;
    this.canvas = canvas;
    this.bus = bus;
    this.bindings = { ...DEFAULT_BINDINGS };
    this.state = new Set();      // actions currently held
    this.edgeDown = new Set();   // actions that went down this frame
    this.edgeUp = new Set();
    this.mouseDelta = { x: 0, y: 0 };
    this.wheel = 0;
    this.locked = false;
    this.enabled = true;
    this._bind();
  }

  _bind() {
    const set = (action, isDown) => {
      if (!action || !this.enabled) return;
      if (isDown) {
        if (!this.state.has(action)) this.edgeDown.add(action);
        this.state.add(action);
      } else {
        if (this.state.has(action)) this.edgeUp.add(action);
        this.state.delete(action);
      }
    };

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const a = this.bindings[e.code];
      if (a) { e.preventDefault(); set(a, true); }
    };
    this._onKeyUp = (e) => {
      const a = this.bindings[e.code];
      if (a) { e.preventDefault(); set(a, false); }
    };
    this._onMouseDown = (e) => { if (this.locked) { e.preventDefault(); set(MOUSE_BINDINGS[e.button], true); } };
    this._onMouseUp = (e) => { if (this.locked) { e.preventDefault(); set(MOUSE_BINDINGS[e.button], false); } };
    this._onMouseMove = (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouseDelta.x += e.movementX || 0;
      this.mouseDelta.y += e.movementY || 0;
    };
    this._onWheel = (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.bus?.emit('input:lock', this.locked);
      if (!this.locked) { this.state.clear(); }
    };
    this._onContext = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('wheel', this._onWheel, { passive: true });
    document.addEventListener('pointerlockchange', this._onLockChange);
    this.canvas.addEventListener('contextmenu', this._onContext);
    this.canvas.addEventListener('click', () => this.requestLock());
  }

  requestLock() {
    if (!this.locked) this.canvas.requestPointerLock?.();
  }

  down(action) { return this.state.has(action); }
  pressed(action) { return this.edgeDown.has(action); }
  released(action) { return this.edgeUp.has(action); }

  /** Consume accumulated mouse motion, converted to radians. */
  consumeLook(adsScale = 1) {
    const s = CFG.camera.sensitivity * adsScale;
    const out = { yaw: -this.mouseDelta.x * s, pitch: -this.mouseDelta.y * s };
    this.mouseDelta.x = 0; this.mouseDelta.y = 0;
    return out;
  }

  /** Called at the very end of a frame by the engine loop. */
  endFrame() {
    this.edgeDown.clear();
    this.edgeUp.clear();
    this.wheel = 0;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}

export default Input;
