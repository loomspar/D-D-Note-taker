// The character window: Gavin's actual skin texture on the standard Minecraft player model.
// The texture is never redrawn — only the head, arms, legs and body are rotated per state.
import { FunctionAnimation, SkinViewer, type PlayerObject } from 'skinview3d';
import type { AvatarState, Settings } from '../shared/types';
import { call, on } from './bridge';

const canvas = document.getElementById('skin') as HTMLCanvasElement;
const stage = document.getElementById('stage')!;
const badge = document.getElementById('badge')!;
const wave = document.getElementById('wave')!;
const placeholder = document.getElementById('placeholder')!;
const bubble = document.getElementById('bubble')!;
const bubbleText = document.getElementById('bubble-text')!;
let charSize = { width: window.innerWidth, height: window.innerHeight };

let state: AvatarState = 'idle';
let reduced = false;
let celebrateUntil = 0;

/** One animation function drives every state so transitions never snap between clips. */
function pose(p: PlayerObject, t: number): void {
  const s = p.skin;
  const k = reduced ? 0.25 : 1;
  p.resetJoints();
  p.position.y = 0; p.rotation.set(0, 0.35, 0);
  const breathe = Math.sin(t * 1.6) * 0.03 * k;
  s.rightArm.rotation.z = 0.06 + breathe; s.leftArm.rotation.z = -0.06 - breathe;
  s.head.rotation.y = Math.sin(t * 0.5) * 0.18 * k;
  switch (state) {
    case 'listening':   // leaning in, head tilted, hand to ear
      s.head.rotation.set(0.08, -0.25, 0.22);
      p.rotation.x = 0.06;
      s.leftArm.rotation.set(-2.85 + Math.sin(t * 2) * 0.04 * k, 0, 0.32);
      break;
    case 'transcribing':
      s.head.rotation.set(0.25, Math.sin(t * 3) * 0.1 * k, 0);
      break;
    case 'thinking':    // hand on chin, slow sway, looking up
      s.head.rotation.set(-0.28, 0.3 + Math.sin(t * 0.9) * 0.15 * k, 0.08);
      s.leftArm.rotation.set(-2.3, 0, 0.55);
      s.rightArm.rotation.set(-0.35, 0, 0.1);
      p.rotation.z = Math.sin(t * 0.9) * 0.03 * k;
      break;
    case 'speaking':    // talking with the hands, small head bob
      s.head.rotation.set(Math.sin(t * 7) * 0.07 * k, Math.sin(t * 1.3) * 0.2 * k, 0);
      s.rightArm.rotation.set(-0.9 + Math.sin(t * 4.2) * 0.35 * k, 0, 0.25);
      s.leftArm.rotation.set(-0.6 + Math.sin(t * 3.4 + 1) * 0.3 * k, 0, -0.25);
      break;
    case 'celebrating': // arms up, jumping
      p.position.y = Math.abs(Math.sin(t * 7)) * 3 * k;
      s.rightArm.rotation.set(0, 0, 2.7 + Math.sin(t * 14) * 0.2 * k);
      s.leftArm.rotation.set(0, 0, -2.7 - Math.sin(t * 14) * 0.2 * k);
      s.head.rotation.x = -0.3;
      break;
    case 'error':       // slumped, slow head shake
      s.head.rotation.set(0.45, Math.sin(t * 2.2) * 0.3 * k, 0);
      s.rightArm.rotation.z = 0.02; s.leftArm.rotation.z = -0.02;
      p.rotation.x = 0.08;
      break;
    default: {          // idle: breathing, an occasional glance and shuffle
      const shuffle = Math.sin(t * 0.7) * 0.04 * k;
      s.rightLeg.rotation.x = shuffle; s.leftLeg.rotation.x = -shuffle;
      s.rightArm.rotation.x = -shuffle; s.leftArm.rotation.x = shuffle;
    }
  }
}
let viewer: SkinViewer | null = null;
try {
  viewer = new SkinViewer({ canvas, width: charSize.width, height: charSize.height, enableControls: false, fov: 38, zoom: 0.82, pixelRatio: 'match-device' });
  viewer.camera.position.set(-18, 9, 62);
  viewer.camera.lookAt(0, 1.5, 0);
  viewer.globalLight.intensity = 2.6;
  viewer.cameraLight.intensity = 1.2;
  viewer.animation = new FunctionAnimation((p, progress) => {
    if (state === 'celebrating' && performance.now() > celebrateUntil) setState('idle');
    pose(p, progress);
  });
} catch {
  // No 3D graphics available (for example a remote session without GPU support): fall back to a flat
  // front view drawn straight from the same texture.
  viewer = null;
  document.body.classList.add('flat');
}

/** Front view of the skin (base layer plus outer layer) on a 2D canvas, pixel-for-pixel from the texture. */
function drawFlat(img: CanvasImageSource, legacy: boolean, slim: boolean): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = charSize.width * dpr; canvas.height = charSize.height * dpr;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.imageSmoothingEnabled = false;
  const u = Math.floor(Math.min(canvas.width / 18, canvas.height / 36));
  const ox = (canvas.width - 16 * u) / 2, oy = (canvas.height - 32 * u) / 2 + u;
  const aw = slim ? 3 : 4;
  const part = (sx: number, sy: number, w: number, h: number, dx: number, dy: number, flip = false) => {
    g.save(); g.translate(ox + dx * u + (flip ? w * u : 0), oy + dy * u); if (flip) g.scale(-1, 1);
    g.drawImage(img, sx, sy, w, h, 0, 0, w * u, h * u); g.restore();
  };
  g.clearRect(0, 0, canvas.width, canvas.height);
  part(8, 8, 8, 8, 4, 0); part(20, 20, 8, 12, 4, 8); part(44, 20, aw, 12, 4 - aw, 8); part(4, 20, 4, 12, 4, 20);
  if (legacy) { part(44, 20, 4, 12, 12, 8, true); part(4, 20, 4, 12, 8, 20, true); part(40, 8, 8, 8, 4, 0); return; }
  part(36, 52, aw, 12, 12, 8); part(20, 52, 4, 12, 8, 20);
  part(40, 8, 8, 8, 4, 0); part(20, 36, 8, 12, 4, 8); part(44, 36, aw, 12, 4 - aw, 8); part(52, 52, aw, 12, 12, 8); part(4, 36, 4, 12, 4, 20); part(4, 52, 4, 12, 8, 20);
}

const LABEL: Record<AvatarState, string> = { idle: '', listening: 'Listening…', transcribing: 'Transcribing…', thinking: 'Thinking…', speaking: 'Speaking', celebrating: 'Saved!', error: 'Something went wrong' };
function setState(s: AvatarState): void {
  state = s;
  if (s === 'celebrating') celebrateUntil = performance.now() + 1800;
  badge.textContent = LABEL[s];
  badge.className = (s === 'idle' ? '' : 'on') + (s === 'error' ? ' error' : '');
  wave.className = s === 'speaking' || s === 'listening' ? 'on' : '';
}

/** Drawn only when no skin has been imported, and always labelled as a placeholder. */
function placeholderSkin(): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4a4458'; g.fillRect(0, 0, 64, 32); g.fillRect(16, 48, 32, 16);
  g.fillStyle = '#6f4fd0'; g.fillRect(16, 16, 24, 16);           // torso
  g.fillStyle = '#39344a'; g.fillRect(0, 16, 16, 16); g.fillRect(16, 48, 16, 16); // legs
  g.fillStyle = '#b48cff'; g.font = 'bold 8px sans-serif'; g.fillText('?', 10, 15); // face
  return c;
}

function applySkin(skin: { png: string; legacy: boolean; model: 'default' | 'slim' | 'auto-detect' } | null): void {
  placeholder.hidden = !!skin;
  if (viewer) {
    if (skin) void viewer.loadSkin(`data:image/png;base64,${skin.png}`, { model: skin.model });
    else viewer.loadSkin(placeholderSkin(), { model: 'default' });
    return;
  }
  if (!skin) { drawFlat(placeholderSkin(), false, false); return; }
  const img = new Image();
  img.onload = () => {
    let slim = skin.model === 'slim';
    if (skin.model === 'auto-detect' && !skin.legacy) {
      // Slim skins leave the last two columns of the right-arm area (x 54–55, y 20–31) fully transparent.
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
      slim = g.getImageData(54, 20, 2, 12).data.every((v, i) => i % 4 !== 3 || v === 0);
    }
    drawFlat(img, skin.legacy, slim);
  };
  img.src = `data:image/png;base64,${skin.png}`;
}

function applySettings(s: Settings): void {
  // The character keeps a fixed size in the bottom-right corner; the window only grows to fit a caption.
  const next = { width: Math.round(s.avatar.size), height: Math.round(s.avatar.size * 1.45) };
  if (next.width !== charSize.width || next.height !== charSize.height) {
    charSize = next;
    if (viewer) viewer.setSize(charSize.width, charSize.height); else void call('skin:get').then(applySkin);
  }
  stage.style.width = `${charSize.width}px`; stage.style.height = `${charSize.height}px`;
  document.body.style.setProperty('--char-h', `${charSize.height}px`);
  reduced = s.avatar.reducedMotion;
  document.body.classList.toggle('reduced', reduced);
}


// Drag to move, click to open the panel, right-click for the menu.
let drag: { x: number; y: number; moved: boolean } | null = null;
stage.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { x: e.screenX, y: e.screenY, moved: false }; stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  drag.moved = true; stage.classList.add('dragging');
  drag.x = e.screenX; drag.y = e.screenY;
  void call('avatar:move', { dx, dy });
});
stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  stage.releasePointerCapture(e.pointerId); stage.classList.remove('dragging');
  void call(drag.moved ? 'avatar:moved' : 'avatar:click');
  drag = null;
});
stage.addEventListener('contextmenu', (e) => { e.preventDefault(); void call('avatar:menu'); });

on('bubble', (b: { text: string; kind: string } | null) => {
  bubble.hidden = !b;
  document.body.classList.toggle('captioned', !!b);
  bubble.className = b?.kind === 'heard' ? 'heard' : b?.kind === 'problem' ? 'problem' : '';
  bubbleText.textContent = b?.text ?? '';
});
on('avatar:state', setState);
on('skin:changed', applySkin);
on('settings:changed', applySettings);
void call('skin:get').then(applySkin);
void call<Settings>('settings:get').then(applySettings);
