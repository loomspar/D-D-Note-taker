// Minecraft skin validation on raw PNG bytes. Classic/slim arm detection is done by skinview3d
// when the texture is loaded (Settings can override it).

export interface StoredSkin { png: string; legacy: boolean; model: 'default' | 'slim' | 'auto-detect'; label: string }

/**
 * Fetch the exact skin texture of a Minecraft Java account from Mojang's public services. Only the two
 * Mojang hosts and Mojang's texture host are contacted; the result is validated like any imported file.
 */
export async function fetchSkinByUsername(username: string, fetchFn: typeof fetch = fetch): Promise<StoredSkin> {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new Error('A Minecraft username is 3–16 letters, numbers or underscores.');
  const get = async (url: string) => { try { return await fetchFn(url); } catch { throw new Error('Could not reach Minecraft’s skin service. Check the internet connection.'); } };
  const prof = await get(`https://api.mojang.com/users/profiles/minecraft/${username}`);
  if (prof.status === 404 || prof.status === 204) throw new Error(`There is no Minecraft Java account called “${username}”.`);
  if (!prof.ok) throw new Error(`Minecraft’s skin service returned an error (${prof.status}). Try again in a minute.`);
  const { id, name } = (await prof.json()) as { id: string; name: string };
  const sess = await get(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`);
  if (!sess.ok) throw new Error(`Minecraft’s skin service returned an error (${sess.status}). Try again in a minute.`);
  const body = (await sess.json()) as { properties?: { name: string; value: string }[] };
  const prop = body.properties?.find((p) => p.name === 'textures');
  const skin = prop ? (JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')).textures?.SKIN as { url: string; metadata?: { model?: string } } | undefined) : undefined;
  if (!skin?.url) throw new Error(`“${name}” has no custom skin set.`);
  const u = new URL(skin.url);
  if (u.hostname !== 'textures.minecraft.net') throw new Error('The skin address was not on Minecraft’s texture server, so it was not downloaded.');
  u.protocol = 'https:';
  const img = await get(u.toString());
  if (!img.ok) throw new Error('The skin image could not be downloaded.');
  const bytes = new Uint8Array(await img.arrayBuffer());
  if (bytes.length > 200_000) throw new Error('That file is too large to be a skin texture.');
  const info = validateSkinPng(bytes);
  return { png: Buffer.from(bytes).toString('base64'), legacy: info.legacy, model: skin.metadata?.model === 'slim' ? 'slim' : 'default', label: `Minecraft account ${name}` };
}

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
