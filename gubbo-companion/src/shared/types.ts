// Types shared by the main process and the renderers. No Node or DOM imports here.

export type AvatarState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'celebrating' | 'error';

export type ChatMode = 'conversation' | 'deep';

export const STAGES = ['Idea', 'Developing', 'Ready to record', 'Recorded', 'Editing', 'Published', 'Reviewed'] as const;
export type Stage = (typeof STAGES)[number];

export const DOC_KINDS = [
  'voice_note', 'brainstorm', 'title_options', 'thumbnail_brief', 'hooks', 'outline', 'script',
  'recording_checklist', 'shot_list', 'editing_notes', 'analytics_review', 'lessons', 'note',
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const MEMORY_KINDS = ['preference', 'accepted', 'rejected', 'lesson', 'next_action', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Where a piece of context came from. Shown to Gavin and passed to the model. */
export type Provenance = 'gavin' | 'gubbo_import' | 'gubbo_folder' | 'analytics' | 'research' | 'assistant';

export interface Settings {
  setupDone: boolean;
  hotkey: string;
  launchAtLogin: boolean;
  avatar: { size: number; alwaysOnTop: boolean; visible: boolean; reducedMotion: boolean; x: number | null; y: number | null };
  voice: { voiceName: string | null; rate: number; pitch: number; volume: number; speakReplies: boolean; whisperModel: string; micDeviceId: string | null };
  ai: { conversationModel: string; deepModel: string; conversationEffort: Effort; deepEffort: Effort; webResearch: boolean; maxSearchesPerTurn: number };
  history: { saveTranscripts: boolean };
  youtube: { launchBriefing: boolean; channelConfirmedId: string | null };
  gubbo: { mode: 'unset' | 'folder' | 'import' | 'later'; folder: string | null; lastFolderScan: string | null };
  /** Overlay behaviour: only the character on screen, replies spoken and captioned beside it. */
  companion: { minimal: boolean; captions: boolean };
  rules: GubboRules;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface GubboRules {
  version: string;
  /** True once Gavin has edited the seeded rules; edited rules are never overwritten by a new seed. */
  userEdited: boolean;
  scoring: string;
  longFormConstraints: string;
  shortsNotes: string;
}

export interface BudgetConfig {
  /** Credit Gavin says is available right now, as shown in the Claude Console. Null until entered. */
  allowanceUsd: number | null;
  /** When Gavin last confirmed the allowance figure. App usage is counted from this moment. */
  allowanceVerifiedAt: string | null;
  /** Credit expiry as shown in the Console (ISO date-time). Stored separately from the calendar month. */
  expiresAt: string | null;
  /** Never dip into this much of the allowance. */
  reserveUsd: number;
  /** Optional extra cap on this app's spend per calendar month. */
  monthlyCapUsd: number | null;
  /** Gavin confirmed: no auto-reload, no payment method / invoicing in use, workspace limit set. */
  spendingVerified: boolean;
  /** Set when the provider reported insufficient credit; cleared when Gavin re-verifies. */
  providerBlocked: string | null;
}

export type BudgetState = 'ok' | 'no_key' | 'unverified' | 'no_allowance' | 'expired' | 'exhausted' | 'provider_blocked';

export interface BudgetStatus {
  state: BudgetState;
  message: string;
  allowanceUsd: number | null;
  /** Settled estimated cost since the allowance was last verified. */
  settledUsd: number;
  /** Reserved or uncertain amounts still held against the allowance. */
  heldUsd: number;
  remainingUsd: number | null;
  monthUsd: number;
  expiresAt: string | null;
  verifiedAt: string | null;
}

export interface LedgerEntry {
  id: number; createdAt: string; model: string; purpose: string;
  reservedUsd: number; actualUsd: number | null;
  status: 'reserved' | 'settled' | 'released' | 'uncertain';
  note: string | null;
}

export interface ChatMessage {
  id: number; conversationId: number; role: 'user' | 'assistant' | 'local';
  text: string; model: string | null; createdAt: string;
  meta: { cancelled?: boolean; viaVoice?: boolean; toolNotes?: string[]; sources?: { url: string; title: string }[]; costUsd?: number; kind?: string };
}

export interface Conversation { id: number; title: string; mode: ChatMode; videoId: number | null; createdAt: string; updatedAt: string }

export interface Video {
  id: number; title: string; premise: string; format: 'long' | 'short'; stage: Stage;
  publishedVideoId: string | null; assetLinks: string[]; createdAt: string; updatedAt: string;
}

export interface DocSummary { id: number; videoId: number | null; kind: DocKind; title: string; version: number; updatedAt: string; author: string }
export interface DocVersion { id: number; documentId: number; version: number; content: string; author: string; createdAt: string }

export interface MemoryItem {
  id: number; kind: MemoryKind; text: string; reason: string | null; provenance: Provenance;
  videoId: number | null; createdAt: string; updatedAt: string;
}

export interface Source { id: number; videoId: number | null; url: string; title: string; publishedDate: string | null; note: string | null; provenance: Provenance; createdAt: string }

export interface Score {
  id: number; videoId: number; createdAt: string; rulesVersion: string; notes: string;
  components: { clarity: number; emotion: number; depth: number; demand: number; originality: number };
  total: number; displayTotal: number; weakest: string;
}

export interface ContextDoc { id: number; source: 'folder' | 'import'; path: string; title: string; chars: number; mtime: string | null; importedAt: string }

export interface SearchHit { kind: string; refId: number; title: string; snippet: string; provenance: Provenance }

export interface UndoEntry { id: number; label: string; createdAt: string; undone: boolean }

export interface ModelInfo { id: string; name: string; available: boolean | null; inputPerMTok: number; outputPerMTok: number; note?: string }

export interface WhisperStatus {
  platformSupported: boolean; binaryReady: boolean; modelReady: boolean; model: string;
  downloadBytes: number; cpu: string; cores: number; memGb: number; recommended: string; note: string;
}

export interface YtChannel { id: string; title: string; customUrl: string | null; thumbnail: string | null; subscriberCountRounded: number | null; hiddenSubscriberCount: boolean; viewCount: number | null; videoCount: number | null; uploadsPlaylistId: string | null }

export interface PeriodTotals {
  start: string; end: string; days: number; complete: boolean; missingDays: string[];
  views: number; minutesWatched: number; avgViewDurationSec: number | null;
  subsGained: number; subsLost: number; netSubs: number;
}
export interface Comparison { current: PeriodTotals; previous: PeriodTotals | null; viewsChangePct: number | null; note: string | null }

export interface YtVideoRow { videoId: string; title: string; publishedAt: string | null; views: number; minutesWatched: number | null; avgViewDurationSec: number | null; subsGainedFromVideo: number | null }

export interface ChannelReport {
  channel: YtChannel;
  fetchedAt: string;
  /** Most recent date the Analytics API returned a row for. Later days are not zero; they are not processed yet. */
  latestDataDate: string | null;
  last7: Comparison | null;
  last28: Comparison | null;
  topVideos28: YtVideoRow[];
  recentUploads: { videoId: string; title: string; publishedAt: string; views: number | null; likes: number | null; comments: number | null; duration: string | null }[];
  warnings: string[];
}

export interface YtStatus {
  configured: boolean; connected: boolean; channelConfirmed: boolean;
  report: ChannelReport | null; stale: boolean; error: string | null;
}

export interface AppStatus {
  version: string; platform: string; arch: string;
  hasApiKey: boolean; secureStorage: boolean;
  hotkey: { accelerator: string; registered: boolean; error: string | null };
  skin: { imported: boolean; source: 'custom' | 'bundled' | 'none'; label: string; model: 'default' | 'slim' | 'auto-detect'; legacy: boolean };
  budget: BudgetStatus;
  dataDir: string;
}

/** Events pushed from main to the panel during a chat turn. */
export type ChatEvent =
  | { type: 'start'; turnId: string; model: string; conversationId: number }
  | { type: 'text'; turnId: string; delta: string }
  | { type: 'tool'; turnId: string; note: string }
  | { type: 'done'; turnId: string; message: ChatMessage; userMessage: ChatMessage; speak: string }
  | { type: 'blocked'; turnId: string; reason: BudgetState | 'offline' | 'model_unavailable' | 'refused' | 'error'; message: string; userMessage?: ChatMessage }
  | { type: 'cancelled'; turnId: string; userMessage?: ChatMessage; message?: ChatMessage };

export interface BrainDumpItem { type: 'idea' | 'task' | 'note' | 'decision'; title: string; text: string; target: string; videoId: number | null }
