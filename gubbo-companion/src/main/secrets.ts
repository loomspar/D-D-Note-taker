// Secrets (Anthropic key, Google client + refresh token) encrypted with the OS credential protection
// (DPAPI on Windows, via Electron safeStorage). Only the main process can read them. They live in their
// own file, never in the database, so backups and exports cannot contain them.
import fs from 'node:fs';
import path from 'node:path';

export interface Crypto { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string }
export type SecretName = 'anthropicKey' | 'ytClientId' | 'ytClientSecret' | 'ytRefreshToken' | 'remoteToken';

export class Secrets {
  private cache = new Map<SecretName, string>();
  constructor(private file: string, private crypto: Crypto) {}

  get available(): boolean { try { return this.crypto.isEncryptionAvailable(); } catch { return false; } }

  private read(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  get(name: SecretName): string | null {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const blob = this.read()[name];
    if (!blob || !this.available) return null;
    try { const v = this.crypto.decryptString(Buffer.from(blob, 'base64')); this.cache.set(name, v); return v; }
    catch { return null; } // e.g. copied from another Windows account: unreadable by design
  }

  has(name: SecretName): boolean { return this.get(name) !== null; }

  set(name: SecretName, value: string): void {
    if (!this.available) throw new Error('Windows credential protection is not available, so the secret was not stored.');
    const all = this.read();
    all[name] = this.crypto.encryptString(value).toString('base64');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
    this.cache.set(name, value);
  }

  clear(...names: SecretName[]): void {
    const all = this.read();
    for (const n of names) { delete all[n]; this.cache.delete(n); }
    try { fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 }); } catch { /* nothing stored yet */ }
  }
}
