import type { GubboRules, Settings } from '../shared/types';
import { type DB, getSetting, setSetting } from './db';

/** Seed of Gavin's Gubbo Virality Score, version 1.0 (11 Nov 2026). A locally edited copy always wins. */
export const SEED_RULES: GubboRules = {
  version: '1.0 (2026-11-11)',
  userEdited: false,
  scoring: `Gubbo Virality Score — editorial judgment, not the probability of going viral.
Five long-form criteria, 0–20 points each; add them and show the total out of 100.
1. Five-second clarity (0–20): a new viewer quickly understands the premise and goal without learning the ending.
2. Emotional pull (0–20): curiosity, amusement, suspense, surprise, anticipation, awe, satisfaction or excitement. Sadness must not be the main appeal.
3. Long-form depth (0–20): a continuing goal, at least three meaningful developments, and a satisfying resolution.
4. Audience demand (0–20): relevant evidence supports interest in this viewing experience.
5. Originality / low saturation (0–20): meaningful differentiation in the goal, mechanism, stakes or payoff.
Do not treat small differences as statistically meaningful. Never inflate a score to reach a requested threshold.
Display range is 1–100: an all-zero concept displays as 1 while its component scores stay 0.`,
  longFormConstraints: `Long-form Minecraft production constraints:
- Solo, Java Edition, entirely in-game.
- Roughly 5–10 hours of recording, excluding editing.
- About 10–20 edited minutes when the footage supports it.
- No required facecam, other players, development team, or fabricated reactions.
- Always show prerequisites and the estimated recording effort.
- Do not pad a short gag into a long-form proposal.`,
  shortsNotes: `Shorts are a separate mode from long-form. Do not reject a good Short for lacking ten minutes of story, and do not apply the long-form depth criterion to it.`,
};

export const DEFAULT_SETTINGS: Settings = {
  setupDone: false,
  hotkey: 'Control+Alt+G',
  launchAtLogin: false,
  avatar: { size: 220, alwaysOnTop: true, visible: true, reducedMotion: false, x: null, y: null },
  voice: { engine: 'neural', neuralVoice: 'am_michael', voiceName: null, rate: 1, pitch: 0.9, volume: 1, speakReplies: true, whisperModel: 'base.en', micDeviceId: null },
  ai: { conversationModel: 'claude-opus-5-5', deepModel: 'claude-fable-5-2', conversationEffort: 'medium', deepEffort: 'high', webResearch: false, maxSearchesPerTurn: 3 },
  history: { saveTranscripts: true },
  youtube: { launchBriefing: true, channelConfirmedId: null },
  gubbo: { mode: 'unset', folder: null, lastFolderScan: null },
  companion: { minimal: true, captions: true },
  rules: SEED_RULES,
};

function merge<T>(base: T, over: any): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over) || typeof base !== 'object' || base === null) return (over === undefined ? base : over) as T;
  const out: any = { ...base };
  for (const k of Object.keys(base as object)) if (k in over) out[k] = merge((base as any)[k], over[k]);
  return out;
}

export function loadSettings(db: DB): Settings {
  return merge(DEFAULT_SETTINGS, getSetting<any>(db, 'app', {}));
}

/** Deep-merges a patch over the stored settings. Unknown keys are dropped by merge(). */
export function saveSettings(db: DB, patch: unknown): Settings {
  const current = loadSettings(db);
  const next = merge(current, patch);
  next.avatar.size = clamp(next.avatar.size, 120, 480);
  next.voice.rate = clamp(next.voice.rate, 0.5, 2);
  next.voice.pitch = clamp(next.voice.pitch, 0, 2);
  next.voice.volume = clamp(next.voice.volume, 0, 1);
  next.ai.maxSearchesPerTurn = Math.round(clamp(next.ai.maxSearchesPerTurn, 1, 5));
  if (JSON.stringify(next.rules) !== JSON.stringify(current.rules)) next.rules.userEdited = true;
  setSetting(db, 'app', next);
  return next;
}

export const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** Display value for a Gubbo score: 1–100, an all-zero concept shows 1. */
export function displayScore(total: number): number {
  return Math.min(100, Math.max(1, Math.round(total)));
}
