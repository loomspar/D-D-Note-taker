// Minecraft skin validation on raw PNG bytes. Classic/slim arm detection is done by skinview3d
// when the texture is loaded (Settings can override it).

export interface SkinInfo { width: number; height: number; legacy: boolean }

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Accepts only real skin textures: PNG, 64×64 (modern) or 64×32 (legacy). A profile picture fails here. */
export function validateSkinPng(buf: Uint8Array): SkinInfo {
  if (buf.length < 33 || !PNG_SIG.every((b, i) => buf[i] === b)) throw new Error('That file is not a PNG image. A Minecraft skin is a small PNG texture file.');
  if (String.fromCharCode(buf[12], buf[13], buf[14], buf[15]) !== 'IHDR') throw new Error('That PNG file is damaged.');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint32(16), height = dv.getUint32(20);
  if (width === 64 && height === 64) return { width, height, legacy: false };
  if (width === 64 && height === 32) return { width, height, legacy: true };
  throw new Error(`That image is ${width}×${height}. A skin texture is 64×64 (or 64×32 for old skins) — this looks like a picture of a character, not the skin file itself. Download the skin PNG from minecraft.net → Profile → Skin, or from your launcher.`);
}
