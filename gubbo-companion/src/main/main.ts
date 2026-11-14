import Anthropic from '@anthropic-ai/sdk';
import { BrowserWindow, Menu, Tray, app, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor, safeStorage, screen, session, shell } from 'electron';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppStatus, AvatarState, BrainDumpItem, ChatEvent, ChatMode, Settings } from '../shared/types';
import { SUGGESTED_HOTKEYS, validateAccelerator } from './accelerator';
import { ChatEngine, applyBrainDump } from './ai';
import { Budget } from './budget';
import { NOTES_DIR, buildGubboExport, importFiles, importPasted, refreshImports, scanFolder, writeNoteToFolder } from './context';
import { type DB, getSetting, openDb, setSetting } from './db';
import { PRICING_CHECKED } from './pricing';
import { clampToDisplays } from './screen';
import { Secrets } from './secrets';
import { loadSettings, saveSettings } from './settings';
import { type StoredSkin, fetchSkinByUsername, validateSkinPng } from './skin';
import { Store } from './store';
import { Whisper, WHISPER_MODELS } from './voice/whisper';
import { answerSubscribers, detectIntent, narrate } from './youtube/briefing';
import { OAuthError, authorize, revoke } from './youtube/oauth';
import { YouTubeService } from './youtube/service';

if (process.env.GUBBO_USER_DATA) app.setPath('userData', process.env.GUBBO_USER_DATA);
const SMOKE = !!process.env.GUBBO_SMOKE;
// The key is only ever sent to Anthropic. A different endpoint is honoured solely in unpackaged development runs.
const API_BASE = !app.isPackaged && process.env.GUBBO_DEV_API_BASE ? process.env.GUBBO_DEV_API_BASE : 'https://api.anthropic.com';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showPanel());
  app.whenReady().then(init).catch((e) => { dialog.showErrorBox('Gubbo Companion could not start', String(e?.stack ?? e)); app.exit(1); });
}

let db: DB;
let store: Store;
let secrets: Secrets;
let budget: Budget;
let engine: ChatEngine;
let yt: YouTubeService;
let whisper: Whisper;
let settings: Settings;
let panel: BrowserWindow | null = null;
let avatar: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let avatarState: AvatarState = 'idle';
let escapeBound = false;
let hotkey = { accelerator: '', registered: false, error: null as string | null };
let launchBriefingDone = false;
let oauthAbort: AbortController | null = null;
let transcribeAbort: AbortController | null = null;
let dbFile = '';

const asset = (name: string) => path.join(app.getAppPath(), 'assets', name);
const page = (name: string) => path.join(app.getAppPath(), 'dist', 'renderer', name);

function send(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const broadcast = (channel: string, payload?: unknown) => { send(panel, channel, payload); send(avatar, channel, payload); };

// ---------------------------------------------------------------- startup

async function init(): Promise<void> {
  app.setAppUserModelId('com.gavin.gubbo-companion');
  Menu.setApplicationMenu(null);
  const dataDir = app.getPath('userData'); // %APPDATA%\Gubbo Companion — outside the install directory
  fs.mkdirSync(dataDir, { recursive: true });
  dbFile = path.join(dataDir, 'gubbo.db');
  applyPendingRestore();
  db = openDb(dbFile);
  store = new Store(db);
  // Development on a machine without OS credential protection only: never active in the packaged app.
  const devPlain = !app.isPackaged && process.env.GUBBO_DEV_INSECURE_SECRETS === '1';
  secrets = new Secrets(path.join(dataDir, 'secrets.json'), devPlain ? { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (b) => b.toString() } : safeStorage);
  settings = loadSettings(db);
  budget = new Budget(db, () => secrets.has('anthropicKey'));
  whisper = new Whisper(path.join(dataDir, 'whisper'), () => settings.voice.whisperModel);
  whisper.purgeTemp();
  yt = new YouTubeService(db, {
    getClient: () => { const id = secrets.get('ytClientId'), sec = secrets.get('ytClientSecret'); return id && sec ? { clientId: id, clientSecret: sec } : null; },
    getRefreshToken: () => secrets.get('ytRefreshToken'),
    clearTokens: () => secrets.clear('ytRefreshToken'),
  }, () => settings.youtube.channelConfirmedId);
  engine = new ChatEngine({
    db, store, budget,
    settings: () => settings,
    client: () => { const key = secrets.get('anthropicKey'); return key ? new Anthropic({ apiKey: key, baseURL: API_BASE, maxRetries: 0 }) : null; },
    tools: {
      store, settings: () => settings,
      channelReport: () => { const s = yt.status(); return { report: s.channelConfirmed ? s.report : null, stale: s.stale, connected: s.connected }; },
      mirrorNote: (title, content) => (settings.gubbo.mode === 'folder' && settings.gubbo.folder ? writeNoteToFolder(settings.gubbo.folder, title, content) : null),
    },
    emit: (ev) => onChatEvent(ev),
  });
  if (!settings.history.saveTranscripts) engine.clearAllHistory();
  if (process.env.GUBBO_SMOKE === 'voice') settings = saveSettings(db, { setupDone: true, voice: { whisperModel: 'tiny.en', speakReplies: false } });

  lockDownSession();
  registerIpc();
  createPanel();
  createAvatar();
  createTray();
  registerHotkey(settings.hotkey);

  screen.on('display-removed', keepAvatarReachable);
  screen.on('display-metrics-changed', keepAvatarReachable);
  powerMonitor.on('suspend', () => cancelInteraction());
  powerMonitor.on('resume', () => { keepAvatarReachable(); if (!globalShortcut.isRegistered(settings.hotkey)) registerHotkey(settings.hotkey); });
  app.on('window-all-closed', () => { /* stays in the tray until Quit */ });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    engine.cancelAll();
    whisper.cancelDownload(); whisper.purgeTemp();
    if (!settings.history.saveTranscripts) engine.clearAllHistory();
    try { db.close(); } catch { /* already closed */ }
  });

  if (settings.gubbo.mode === 'folder' && settings.gubbo.folder) rescanGubbo();
  if (SMOKE) runSmoke();
}

function lockDownSession(): void {
  const ses = session.defaultSession;
  // Only the microphone is ever granted, and only to the app's own pages.
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const own = wc.getURL().startsWith(pathToFileURL(app.getAppPath()).href);
    cb(own && permission === 'media' && !(details as any).mediaTypes?.includes('video'));
  });
  ses.setPermissionCheckHandler((wc, permission) => !!wc && wc.getURL().startsWith(pathToFileURL(app.getAppPath()).href) && (permission === 'media' || permission === 'speaker-selection'));
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => { if (!url.startsWith(pathToFileURL(app.getAppPath()).href)) { e.preventDefault(); openExternal(url); } });
  });
}

function openExternal(url: string): void {
  try { if (new URL(url).protocol === 'https:') void shell.openExternal(url); } catch { /* not a URL */ }
}

const webPreferences = () => ({
  preload: path.join(app.getAppPath(), 'dist', 'preload', 'preload.js'),
  contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
  backgroundThrottling: false, spellcheck: false,
});

// ---------------------------------------------------------------- windows

function createPanel(): void {
  panel = new BrowserWindow({
    width: 1000, height: 740, minWidth: 460, minHeight: 520, show: false, title: 'Gubbo Companion',
    backgroundColor: '#1b1a20', icon: asset('icon.png'), autoHideMenuBar: true, webPreferences: webPreferences(),
  });
  void panel.loadFile(page('panel.html'));
  // Started by Windows at sign-in (--hidden): stay in the tray with just the character showing.
  panel.once('ready-to-show', () => { if (!settings.setupDone || (!process.argv.includes('--hidden') && !settings.companion.minimal)) panel?.show(); });
  panel.on('close', (e) => { if (!quitting) { e.preventDefault(); panel?.hide(); } });
}

function avatarSize() { return { width: Math.round(settings.avatar.size), height: Math.round(settings.avatar.size * 1.45) }; }

function createAvatar(): void {
  const { width, height } = avatarSize();
  const primary = screen.getPrimaryDisplay().workArea;
  const pos = clampToDisplays(
    { x: settings.avatar.x ?? primary.x + primary.width - width - 24, y: settings.avatar.y ?? primary.y + primary.height - height - 24, width, height },
    screen.getAllDisplays().map((d) => d.workArea), primary);
  avatar = new BrowserWindow({
    ...pos, width, height, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true,
    hasShadow: false, fullscreenable: false, maximizable: false, minimizable: false, focusable: true,
    alwaysOnTop: settings.avatar.alwaysOnTop, title: 'Gubbo', webPreferences: webPreferences(),
  });
  if (settings.avatar.alwaysOnTop) avatar.setAlwaysOnTop(true, 'floating');
  void avatar.loadFile(page('avatar.html'));
  avatar.once('ready-to-show', () => { if (settings.avatar.visible) avatar?.showInactive(); });
  avatar.on('close', (e) => { if (!quitting) { e.preventDefault(); avatar?.hide(); } });
}

function keepAvatarReachable(): void {
  if (!avatar || avatar.isDestroyed()) return;
  const b = avatar.getBounds();
  const pos = clampToDisplays(b, screen.getAllDisplays().map((d) => d.workArea), screen.getPrimaryDisplay().workArea);
  if (pos.x !== b.x || pos.y !== b.y) { avatar.setPosition(pos.x, pos.y); saveAvatarPosition(); }
}

/** The character sits in the bottom-right of its window; the saved position is that of the character itself. */
function saveAvatarPosition(): void {
  if (!avatar || avatar.isDestroyed()) return;
  const b = avatar.getBounds(), c = avatarSize();
  settings = saveSettings(db, { avatar: { x: b.x + b.width - c.width, y: b.y + b.height - c.height } });
}

let bubbleOpen = false;
/** Show or clear the caption beside the character. The window grows up and to the left to make room. */
function setBubble(payload: { text: string; kind: string } | null): void {
  if (!avatar || avatar.isDestroyed()) return;
  const show = !!payload && settings.companion.captions;
  if (show !== bubbleOpen) {
    bubbleOpen = show;
    const b = avatar.getBounds(), c = avatarSize();
    const right = b.x + b.width, bottom = b.y + b.height;
    const width = show ? Math.max(c.width, 400) : c.width, height = show ? c.height + 170 : c.height;
    const area = screen.getDisplayMatching(b).workArea;
    avatar.setResizable(true);
    avatar.setBounds({ x: Math.max(area.x, right - width), y: Math.max(area.y, bottom - height), width, height });
    avatar.setResizable(false);
  }
  send(avatar, 'bubble', show ? payload : null);
}

function applyAvatarSettings(): void {
  if (!avatar || avatar.isDestroyed()) return;
  const { width, height } = avatarSize();
  bubbleOpen = false; send(avatar, 'bubble', null);
  avatar.setResizable(true); avatar.setSize(width, height); avatar.setResizable(false);
  avatar.setAlwaysOnTop(settings.avatar.alwaysOnTop, 'floating');
  if (settings.avatar.visible) { if (!avatar.isVisible()) avatar.showInactive(); } else avatar.hide();
  keepAvatarReachable();
}

function showPanel(tab?: string): void {
  if (!panel || panel.isDestroyed()) createPanel();
  if (panel!.isMinimized()) panel!.restore();
  panel!.show(); panel!.focus();
  if (tab) send(panel, 'nav', tab);
}

function createTray(): void {
  try {
    tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  } catch { tray = null; return; } // no system tray on this desktop
  tray.setToolTip('Gubbo Companion');
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
  tray.on('click', () => showPanel());
}

function menuTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: 'Open', click: () => showPanel('chat') },
    { label: 'Talk', click: () => toggleTalk() },
    { label: 'Channel briefing', click: () => { showPanel('channel'); send(panel, 'briefing:request'); } },
    { type: 'separator' },
    { label: settings.avatar.visible ? 'Hide character' : 'Show character', click: () => { settings = saveSettings(db, { avatar: { visible: !settings.avatar.visible } }); applyAvatarSettings(); tray?.setContextMenu(Menu.buildFromTemplate(menuTemplate())); broadcast('settings:changed', settings); } },
    { label: 'Settings', click: () => showPanel('settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => quit() },
  ];
}

function quit(): void {
  quitting = true;
  cancelInteraction();           // stops recording, generation and speech before the windows go away
  setTimeout(() => app.quit(), 120);
}

// ---------------------------------------------------------------- hotkey and interaction

function registerHotkey(acc: string): { ok: boolean; error: string | null } {
  let valid: string;
  try { valid = validateAccelerator(acc); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const previous = hotkey.registered ? hotkey.accelerator : null;
  if (previous) globalShortcut.unregister(previous);
  let ok = false;
  try { ok = globalShortcut.register(valid, () => toggleTalk()); } catch { ok = false; }
  if (!ok) {
    // Another program owns this combination. Keep the old one working and report it.
    if (previous && previous !== valid) { try { globalShortcut.register(previous, () => toggleTalk()); } catch { /* ignore */ } }
    const error = `${valid.replace(/\+/g, ' + ')} is already used by another program, so Windows would not give it to Gubbo. Pick a different shortcut.`;
    hotkey = previous && previous !== valid ? { accelerator: previous, registered: true, error } : { accelerator: valid, registered: false, error };
    return { ok: false, error };
  }
  hotkey = { accelerator: valid, registered: true, error: null };
  return { ok: true, error: null };
}

/** Hotkey / tray "Talk": summon the companion and toggle recording. The panel owns the microphone. */
function toggleTalk(): void {
  if (settings.avatar.visible && avatar && !avatar.isVisible()) avatar.showInactive();
  if (!panel || panel.isDestroyed()) createPanel();
  // In companion mode the panel stays out of the way: only Gubbo is on screen.
  if (!settings.companion.minimal && !panel!.isVisible()) panel!.showInactive();
  send(panel, 'voice:toggle');
}

const stateLog: string[] = [];
function setAvatarState(state: AvatarState): void {
  avatarState = state;
  if (SMOKE) stateLog.push(state);
  send(avatar, 'avatar:state', state);
  // Escape is intercepted globally only while something is actually in progress.
  const active = state === 'listening' || state === 'transcribing' || state === 'thinking' || state === 'speaking';
  if (active && !escapeBound) { try { escapeBound = globalShortcut.register('Escape', () => cancelInteraction()); } catch { escapeBound = false; } }
  else if (!active && escapeBound) { globalShortcut.unregister('Escape'); escapeBound = false; }
}

function cancelInteraction(): void {
  engine?.cancelAll();
  transcribeAbort?.abort();
  send(panel, 'voice:cancel');   // panel drops the recording without sending it and stops speech
}

function onChatEvent(ev: ChatEvent): void {
  send(panel, 'chat:event', ev);
}

// ---------------------------------------------------------------- helpers used by IPC

let bundledSkin: StoredSkin | null | undefined;
/** Gavin's own skin: a custom import if there is one, otherwise the Gubbo skin shipped with the app. */
function currentSkin(): { skin: StoredSkin | null; source: 'custom' | 'bundled' | 'none' } {
  const custom = getSetting<StoredSkin | null>(db, 'skin', null);
  if (custom) return { skin: { ...custom, label: custom.label ?? 'Imported file' }, source: 'custom' };
  if (bundledSkin === undefined) {
    try { const bytes = fs.readFileSync(asset('gubbo-skin.png')); const info = validateSkinPng(bytes); bundledSkin = { png: bytes.toString('base64'), legacy: info.legacy, model: 'default', label: 'Gubbo (Minecraft account GubboYT)' }; }
    catch { bundledSkin = null; }
  }
  return bundledSkin ? { skin: bundledSkin, source: 'bundled' } : { skin: null, source: 'none' };
}

function appStatus(): AppStatus {
  const { skin, source } = currentSkin();
  return {
    version: app.getVersion(), platform: process.platform, arch: process.arch,
    hasApiKey: secrets.has('anthropicKey'), secureStorage: secrets.available,
    hotkey, skin: { imported: !!skin, source, label: skin?.label ?? '', model: skin?.model ?? 'auto-detect', legacy: !!skin?.legacy },
    budget: budget.status(), dataDir: app.getPath('userData'),
  };
}

function rescanGubbo(): { indexed: number; updated: number; removed: number; skipped: number } | { error: string } {
  if (!settings.gubbo.folder) return { error: 'No folder is connected.' };
  try {
    const r = scanFolder(store, settings.gubbo.folder);
    settings = saveSettings(db, { gubbo: { lastFolderScan: new Date().toISOString() } });
    return r;
  } catch (e) { return { error: (e as Error).message }; }
}

async function briefing(kind: 'briefing' | 'subscribers', force: boolean): Promise<{ ok: boolean; text: string; stale: boolean }> {
  const before = yt.status();
  if (!before.connected) return { ok: false, text: 'YouTube isn’t connected yet. Open the Channel tab to connect it.', stale: false };
  const st = await yt.refresh({ force });
  if (!st.connected) return { ok: false, text: 'YouTube needs to be reconnected. Open the Channel tab.', stale: false };
  if (!st.report) return { ok: false, text: `I couldn’t get your channel figures${st.error ? `: ${st.error}` : '.'}`, stale: false };
  if (!st.channelConfirmed) return { ok: false, text: 'Please confirm which channel this is in the Channel tab first.', stale: false };
  return { ok: true, stale: st.stale, text: kind === 'subscribers' ? answerSubscribers(st.report, st.stale) : narrate(st.report, { stale: st.stale }) };
}

function applyPendingRestore(): void {
  const pending = `${dbFile}.restore`;
  if (!fs.existsSync(pending)) return;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.renameSync(pending, dbFile);
}

// ---------------------------------------------------------------- IPC

type Handler = (payload: any) => unknown | Promise<unknown>;

function registerIpc(): void {
  const own = pathToFileURL(app.getAppPath()).href;
  const handle = (channel: string, fn: Handler) => {
    ipcMain.handle(channel, async (event, payload) => {
      // Requests are only accepted from the app's own two pages.
      if (!event.senderFrame || !event.senderFrame.url.startsWith(own)) return { ok: false, error: 'Rejected.' };
      try { return { ok: true, value: await fn(payload) }; }
      catch (e) { return { ok: false, error: (e as Error).message || 'Something went wrong.' }; }
    });
  };
  const int = (v: unknown, name = 'id'): number => { if (!Number.isSafeInteger(v)) throw new Error(`Invalid ${name}.`); return v as number; };
  const intOrNull = (v: unknown) => (v === null || v === undefined ? null : int(v));
  const text = (v: unknown, max: number, name: string): string => { if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${name}.`); return v; };
  const changed = () => { broadcast('settings:changed', settings); tray?.setContextMenu(Menu.buildFromTemplate(menuTemplate())); };

  // ---- app / settings
  handle('app:status', () => appStatus());
  handle('app:info', () => ({ pricingChecked: PRICING_CHECKED, suggestedHotkeys: SUGGESTED_HOTKEYS, whisperModels: Object.entries(WHISPER_MODELS).map(([id, m]) => ({ id, label: m.label, mb: Math.round(m.bytes / 1e6) })), notesDir: NOTES_DIR }));
  handle('settings:get', () => settings);
  handle('settings:set', (patch) => {
    if (patch === null || typeof patch !== 'object' || 'hotkey' in patch) throw new Error('Invalid settings.');
    settings = saveSettings(db, patch);
    if ('avatar' in patch) applyAvatarSettings();
    if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ['--hidden'] });
    changed();
    return settings;
  });
  handle('hotkey:set', (acc) => {
    const r = registerHotkey(text(acc, 60, 'shortcut'));
    if (r.ok) { settings = saveSettings(db, { hotkey: hotkey.accelerator }); changed(); }
    return { ...r, hotkey };
  });
  handle('external:open', (url) => openExternal(text(url, 2000, 'link')));
  handle('panel:show', (tab) => showPanel(typeof tab === 'string' ? tab : undefined));
  handle('panel:ready', async () => {
    // Launch briefing: once per app launch, never on later summons.
    if (launchBriefingDone) return null;
    launchBriefingDone = true;
    if (!settings.setupDone || !settings.youtube.launchBriefing || !yt.status().connected) return null;
    const b = await briefing('briefing', false);
    return b.ok ? b : null;
  });
  handle('app:quit', () => quit());

  // ---- avatar window
  handle('avatar:move', (p) => {
    if (!avatar) return;
    const [x, y] = avatar.getPosition();
    avatar.setPosition(x + Math.round(Number(p?.dx) || 0), y + Math.round(Number(p?.dy) || 0));
  });
  handle('avatar:moved', () => { keepAvatarReachable(); saveAvatarPosition(); });
  handle('avatar:click', () => { if (panel?.isVisible() && panel.isFocused()) panel.hide(); else showPanel(); });
  handle('avatar:menu', () => { Menu.buildFromTemplate(menuTemplate()).popup({ window: avatar ?? undefined }); });
  handle('avatar:talk', () => toggleTalk());
  handle('bubble:set', (p) => setBubble(p && typeof p.text === 'string' && p.text.trim() ? { text: p.text.slice(0, 600), kind: typeof p.kind === 'string' ? p.kind.slice(0, 20) : 'say' } : null));

  // ---- skin
  handle('skin:get', () => currentSkin().skin);
  handle('skin:fromUsername', async (name) => {
    const skin = await fetchSkinByUsername(text(name, 16, 'username').trim());
    setSetting(db, 'skin', skin);
    broadcast('skin:changed', skin);
    return skin;
  });
  handle('skin:import', async () => {
    const r = await dialog.showOpenDialog(panel!, { title: 'Choose your Minecraft skin file', filters: [{ name: 'Minecraft skin (PNG)', extensions: ['png'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    if (fs.statSync(r.filePaths[0]).size > 200_000) throw new Error('That file is too large to be a skin texture.');
    const bytes = fs.readFileSync(r.filePaths[0]);
    const info = validateSkinPng(bytes);
    const skin: StoredSkin = { png: bytes.toString('base64'), legacy: info.legacy, model: 'auto-detect', label: `File ${path.basename(r.filePaths[0])}` };
    setSetting(db, 'skin', skin);
    broadcast('skin:changed', skin);
    return skin;
  });
  handle('skin:model', (model) => {
    if (!['default', 'slim', 'auto-detect'].includes(model)) throw new Error('Invalid arm type.');
    const skin = currentSkin().skin ? { ...currentSkin().skin! } : null;
    if (!skin) throw new Error('Import a skin first.');
    skin.model = model; setSetting(db, 'skin', skin); broadcast('skin:changed', skin);
    return skin;
  });
  handle('skin:remove', () => { db.prepare("DELETE FROM settings WHERE key = 'skin'").run(); broadcast('skin:changed', currentSkin().skin); });

  // ---- Claude key, models, budget
  handle('key:set', async (key) => {
    const k = text(key, 400, 'key').trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new Error('That does not look like an Anthropic API key (it should start with “sk-ant-”).');
    if (k.startsWith('sk-ant-admin')) throw new Error('That is an Admin key. Create a normal API key in a workspace for this app instead.');
    // Listing models is free and proves the key works before it is stored.
    try { await new Anthropic({ apiKey: k, baseURL: API_BASE, maxRetries: 0 }).models.list({ limit: 1 }, { timeout: 15_000 }); }
    catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected that key. Check that it was copied completely.');
      if (!(e instanceof Anthropic.APIConnectionError)) throw new Error(`The key could not be checked (${(e as Error).message.slice(0, 120)}).`);
      // Offline: store it, it will be checked on first use.
    }
    secrets.set('anthropicKey', k);
    return appStatus();
  });
  handle('key:clear', () => { secrets.clear('anthropicKey'); return appStatus(); });
  handle('models:list', () => engine.modelInfo());
  handle('budget:status', () => ({ status: budget.status(), config: budget.config(), ledger: budget.ledger(60) }));
  handle('budget:verify', (p) => {
    budget.verify({ allowanceUsd: Number(p?.allowanceUsd), expiresAt: p?.expiresAt ? String(p.expiresAt) : null, reserveUsd: Number(p?.reserveUsd ?? 0), monthlyCapUsd: p?.monthlyCapUsd === null || p?.monthlyCapUsd === '' || p?.monthlyCapUsd === undefined ? null : Number(p.monthlyCapUsd), spendingVerified: p?.spendingVerified === true });
    return { status: budget.status(), config: budget.config(), ledger: budget.ledger(60) };
  });
  handle('budget:resolve', (p) => { budget.resolveUncertain(int(p?.id), p?.actualUsd === null || p?.actualUsd === undefined ? null : Number(p.actualUsd)); return { status: budget.status(), config: budget.config(), ledger: budget.ledger(60) }; });

  // ---- chat
  handle('chat:conversations', () => engine.listConversations());
  handle('chat:messages', (id) => engine.messages(int(id)));
  handle('chat:delete', (id) => engine.deleteConversation(int(id)));
  handle('chat:clear', () => engine.clearAllHistory());
  handle('chat:cancel', (turnId) => engine.cancel(text(turnId, 80, 'turn')));
  handle('chat:send', async (p) => {
    const turnId = text(p?.turnId, 80, 'turn');
    const body = text(p?.text, 60_000, 'message');
    const conversationId = intOrNull(p?.conversationId);
    const mode: ChatMode = p?.mode === 'deep' ? 'deep' : 'conversation';
    // Channel questions are answered from fetched figures with a fixed template: no model call, no cost.
    const intent = p?.includeAnalytics ? null : detectIntent(body);
    if (intent && yt.status().connected) {
      onChatEvent({ type: 'start', turnId, model: 'local', conversationId: conversationId ?? 0 });
      const b = await briefing(intent, true);
      const ex = engine.addLocalExchange(conversationId, body, b.text, 'briefing');
      onChatEvent({ type: 'done', turnId, userMessage: ex.messages[0], message: ex.messages[1], speak: b.text });
      return;
    }
    let extra: string | undefined;
    if (p?.includeAnalytics) {
      const s = yt.status();
      extra = s.report && s.channelConfirmed ? `Channel analytics fetched by the app at ${s.report.fetchedAt}${s.stale ? ' (cached, may be stale)' : ''}:\n${JSON.stringify(s.report)}` : 'No channel analytics are available in the app right now.';
    }
    void engine.send({ turnId, conversationId, text: body, mode, videoId: intOrNull(p?.videoId), viaVoice: p?.viaVoice === true, extraContext: extra });
  });

  // ---- voice
  handle('voice:state', (s) => { if (['idle', 'listening', 'transcribing', 'thinking', 'speaking', 'celebrating', 'error'].includes(s)) setAvatarState(s); });
  handle('whisper:status', () => whisper.status());
  handle('whisper:download', async () => whisper.download((p) => send(panel, 'whisper:progress', p)));
  handle('whisper:cancel', () => whisper.cancelDownload());
  handle('voice:transcribe', async (wav) => {
    if (!(wav instanceof ArrayBuffer) && !ArrayBuffer.isView(wav)) throw new Error('Invalid audio.');
    const bytes = wav instanceof ArrayBuffer ? new Uint8Array(wav) : new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
    transcribeAbort = new AbortController();
    try { return await whisper.transcribe(bytes, transcribeAbort.signal); }
    catch (e) { if (transcribeAbort.signal.aborted) return null; throw e; }
    finally { transcribeAbort = null; }
  });

  // ---- YouTube
  handle('yt:status', () => yt.status());
  handle('yt:setClient', (p) => {
    const id = text(p?.clientId, 200, 'client ID').trim(), sec = text(p?.clientSecret, 200, 'client secret').trim();
    if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('The client ID should end with “.apps.googleusercontent.com”. Copy it from the Google Cloud console.');
    if (sec.length < 10) throw new Error('The client secret looks too short.');
    secrets.set('ytClientId', id); secrets.set('ytClientSecret', sec);
    return yt.status();
  });
  handle('yt:connect', async () => {
    const id = secrets.get('ytClientId'), sec = secrets.get('ytClientSecret');
    if (!id || !sec) throw new Error('Enter the Google client ID and secret first.');
    oauthAbort?.abort();
    oauthAbort = new AbortController();
    try {
      const tokens = await authorize({ clientId: id, clientSecret: sec }, (url) => void shell.openExternal(url), { signal: oauthAbort.signal });
      secrets.set('ytRefreshToken', tokens.refreshToken);
      yt.disconnectLocal();
      settings = saveSettings(db, { youtube: { channelConfirmedId: null } });
      return await yt.refresh({ force: true });
    } catch (e) {
      if (e instanceof OAuthError && e.code === 'denied') throw new Error('Access was not granted. If Google said the app is “not verified” or you are “not a test user”, add your Google account under OAuth consent screen → Test users, then try again.');
      throw e;
    } finally { oauthAbort = null; }
  });
  handle('yt:cancelConnect', () => oauthAbort?.abort());
  handle('yt:confirmChannel', (id) => {
    const st = yt.status();
    if (!st.report || st.report.channel.id !== id) throw new Error('That is not the connected channel.');
    settings = saveSettings(db, { youtube: { channelConfirmedId: st.report.channel.id } });
    return yt.status();
  });
  handle('yt:disconnect', async (p) => {
    const rt = secrets.get('ytRefreshToken');
    if (rt) await revoke(rt);
    secrets.clear('ytRefreshToken');
    if (p?.forgetClient) secrets.clear('ytClientId', 'ytClientSecret');
    yt.disconnectLocal();
    settings = saveSettings(db, { youtube: { channelConfirmedId: null } });
    return yt.status();
  });
  handle('yt:refresh', () => yt.refresh({ force: true }));
  handle('yt:briefing', (kind) => briefing(kind === 'subscribers' ? 'subscribers' : 'briefing', true));

  // ---- project workspace
  handle('videos:list', () => store.listVideos());
  handle('video:get', (id) => {
    const v = store.getVideo(int(id));
    if (!v) throw new Error('That video no longer exists.');
    return { video: v, documents: store.listDocuments(v.id), scores: store.listScores(v.id), sources: store.listSources(v.id), memory: store.listMemory({ videoId: v.id }) };
  });
  handle('video:create', (p) => store.createVideo({ title: p?.title, premise: p?.premise ?? '', format: p?.format, stage: p?.stage }));
  handle('video:update', (p) => store.updateVideo(int(p?.id), p?.patch ?? {}));
  handle('video:delete', async (id) => {
    const v = store.getVideo(int(id));
    if (!v) return false;
    const r = await dialog.showMessageBox(panel!, { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: `Delete “${v.title}”?`, detail: 'Its documents, scores, sources and decisions are deleted too. This cannot be undone.' });
    if (r.response !== 0) return false;
    store.deleteVideo(v.id); return true;
  });
  handle('docs:list', (videoId) => store.listDocuments(intOrNull(videoId)));
  handle('doc:get', (id) => store.getDocument(int(id)));
  handle('doc:save', (p) => store.saveDocument({ documentId: intOrNull(p?.documentId), videoId: intOrNull(p?.videoId), kind: p?.kind, title: p?.title, content: p?.content, author: 'gavin' }));
  handle('doc:revert', (p) => { store.revertDocument(int(p?.id), int(p?.version, 'version')); return store.getDocument(int(p?.id)); });
  handle('doc:delete', (id) => store.deleteDocument(int(id)));
  handle('memory:list', () => store.listMemory());
  handle('memory:add', (p) => store.addMemory({ kind: p?.kind, text: p?.text, reason: p?.reason, videoId: intOrNull(p?.videoId), provenance: 'gavin' }));
  handle('memory:update', (p) => store.updateMemory(int(p?.id), { text: p?.text, reason: p?.reason, kind: p?.kind }));
  handle('memory:delete', (id) => store.deleteMemory(int(id)));
  handle('source:add', (p) => store.addSource({ videoId: intOrNull(p?.videoId), url: p?.url, title: p?.title, publishedDate: p?.publishedDate || undefined, note: p?.note || undefined, provenance: 'gavin' }));
  handle('source:delete', (id) => store.deleteSource(int(id)));
  handle('search', (q) => store.search(text(q, 500, 'query'), 20));
  handle('activity', () => store.recentActivity());
  handle('undo:list', () => store.undoList());
  handle('undo:do', (id) => store.undo(int(id)));
  handle('braindump:preview', (t) => engine.brainDump(text(t, 60_000, 'transcript')));
  handle('braindump:apply', (p) => {
    const items = (Array.isArray(p?.items) ? p.items : []).slice(0, 40).filter((i: BrainDumpItem) => i && typeof i.title === 'string' && typeof i.text === 'string' && ['idea', 'task', 'note', 'decision'].includes(i.type))
      .map((i: BrainDumpItem) => ({ type: i.type, title: i.title, text: i.text, target: '', videoId: intOrNull(i.videoId) }));
    return applyBrainDump(store, text(p?.transcript, 60_000, 'transcript'), items, intOrNull(p?.videoId));
  });

  // ---- Gubbo project connection
  handle('gubbo:list', () => ({ docs: store.listContextDocs(), settings: settings.gubbo }));
  handle('gubbo:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(panel!, { title: 'Choose your Gubbo folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    for (const d of store.listContextDocs().filter((x) => x.source === 'folder')) store.removeContextDoc(d.id);
    settings = saveSettings(db, { gubbo: { mode: 'folder', folder: r.filePaths[0] } });
    const scan = rescanGubbo(); changed();
    return { scan, docs: store.listContextDocs(), settings: settings.gubbo };
  });
  handle('gubbo:rescan', () => ({ scan: rescanGubbo(), docs: store.listContextDocs(), settings: settings.gubbo }));
  handle('gubbo:disconnectFolder', () => {
    for (const d of store.listContextDocs().filter((x) => x.source === 'folder')) store.removeContextDoc(d.id);
    settings = saveSettings(db, { gubbo: { mode: store.listContextDocs().length ? 'import' : 'later', folder: null, lastFolderScan: null } }); changed();
    return { docs: store.listContextDocs(), settings: settings.gubbo };
  });
  handle('gubbo:importFiles', async () => {
    const r = await dialog.showOpenDialog(panel!, { title: 'Choose Gubbo project files to import', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Text documents', extensions: ['md', 'markdown', 'txt', 'json', 'csv', 'yaml', 'yml', 'html'] }] });
    if (r.canceled) return null;
    const result = importFiles(store, r.filePaths.slice(0, 200));
    if (settings.gubbo.mode !== 'folder') { settings = saveSettings(db, { gubbo: { mode: 'import' } }); changed(); }
    return { result, docs: store.listContextDocs(), settings: settings.gubbo };
  });
  handle('gubbo:importPasted', (p) => {
    importPasted(store, text(p?.title, 200, 'title'), text(p?.text, 600_000, 'text'));
    if (settings.gubbo.mode !== 'folder') { settings = saveSettings(db, { gubbo: { mode: 'import' } }); changed(); }
    return { docs: store.listContextDocs(), settings: settings.gubbo };
  });
  handle('gubbo:refreshImports', () => ({ result: refreshImports(store), docs: store.listContextDocs(), settings: settings.gubbo }));
  handle('gubbo:remove', (id) => { store.removeContextDoc(int(id)); return { docs: store.listContextDocs(), settings: settings.gubbo }; });
  handle('gubbo:later', () => { settings = saveSettings(db, { gubbo: { mode: 'later' } }); changed(); return settings.gubbo; });
  handle('gubbo:export', async () => {
    const md = buildGubboExport(store, settings.rules);
    const r = await dialog.showSaveDialog(panel!, { title: 'Export for Gubbo', defaultPath: `Gubbo Companion export ${new Date().toISOString().slice(0, 10)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, md, 'utf8');
    return r.filePath;
  });

  // ---- backup / restore (project data only; secrets are in a separate protected file and never included)
  handle('backup:export', async () => {
    const r = await dialog.showSaveDialog(panel!, { title: 'Back up Gubbo Companion data', defaultPath: `Gubbo Companion backup ${new Date().toISOString().slice(0, 10)}.gubbo-backup`, filters: [{ name: 'Gubbo Companion backup', extensions: ['gubbo-backup'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.rmSync(r.filePath, { force: true });
    db.prepare('VACUUM INTO ?').run(r.filePath);
    return r.filePath;
  });
  handle('backup:restore', async () => {
    const r = await dialog.showOpenDialog(panel!, { title: 'Restore a backup', filters: [{ name: 'Gubbo Companion backup', extensions: ['gubbo-backup'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return false;
    const head = Buffer.alloc(16);
    const fd = fs.openSync(r.filePaths[0], 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
    if (head.toString('latin1') !== 'SQLite format 3\u0000') throw new Error('That file is not a Gubbo Companion backup.');
    const probe = new DatabaseSync(r.filePaths[0], { readOnly: true });
    try {
      const tables = new Set((probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
      if (!['settings', 'videos', 'messages', 'ledger'].every((t) => tables.has(t))) throw new Error('That file is not a Gubbo Companion backup.');
    } finally { probe.close(); }
    const c = await dialog.showMessageBox(panel!, { type: 'warning', buttons: ['Restore and restart', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Replace current data with this backup?', detail: 'Everything saved since that backup will be lost. API keys and the YouTube sign-in are not affected.' });
    if (c.response !== 0) return false;
    fs.copyFileSync(r.filePaths[0], `${dbFile}.restore`);
    app.relaunch(); quit();
    return true;
  });
}

// ---------------------------------------------------------------- packaged smoke test

/** `GUBBO_SMOKE=1`: verify the shell came up, print a JSON report and exit. Used by CI on Windows. */
function runSmoke(): void {
  const report: Record<string, unknown> = { platform: process.platform, arch: process.arch, packaged: app.isPackaged, version: app.getVersion() };
  const finish = (ok: boolean) => { report.ok = ok; fs.writeFileSync(path.join(app.getPath('userData'), 'smoke.json'), JSON.stringify(report, null, 2)); console.log(`SMOKE ${JSON.stringify(report)}`); app.exit(ok ? 0 : 1); };
  const timer = setTimeout(() => finish(false), 45_000);
  let loaded = 0;
  const check = async () => {
    if (++loaded < 2) return;
    try {
      report.hotkeyRegistered = hotkey.registered; report.hotkey = hotkey.accelerator;
      report.tray = !!tray; report.secureStorage = secrets.available;
      report.singleInstanceLock = app.hasSingleInstanceLock();
      report.panelTitle = await panel!.webContents.executeJavaScript('document.title');
      report.panelRendered = await panel!.webContents.executeJavaScript('!!document.querySelector("[data-app-ready]")');
      report.bridgeIsNarrow = await panel!.webContents.executeJavaScript('typeof window.require === "undefined" && typeof window.process === "undefined" && Object.keys(window.gubbo).sort().join(",")');
      report.avatarCanvas = await avatar!.webContents.executeJavaScript('(() => { const c = document.querySelector("canvas"); return !!c && c.width > 0; })()');
      report.avatarPlaceholderLabel = await avatar!.webContents.executeJavaScript('document.querySelector("#placeholder")?.textContent ?? null');
      report.voices = await panel!.webContents.executeJavaScript('new Promise(r => { const v = speechSynthesis.getVoices(); if (v.length) r(v.map(x => x.name)); else { speechSynthesis.onvoiceschanged = () => r(speechSynthesis.getVoices().map(x => x.name)); setTimeout(() => r([]), 3000); } })');
      report.budgetState = budget.status().state;
      report.dataDir = app.getPath('userData');
      report.whisper = whisper.status();
      if (process.env.GUBBO_SMOKE === 'voice') { clearTimeout(timer); await voiceSmoke(report); finish(report.voiceOk === true); return; }
      clearTimeout(timer);
      finish(report.panelRendered === true && report.avatarCanvas === true && report.budgetState === 'no_key');
    } catch (e) { report.error = String(e); clearTimeout(timer); finish(false); }
  };
  panel!.webContents.once('did-finish-load', () => setTimeout(check, 1500));
  avatar!.webContents.once('did-finish-load', () => setTimeout(check, 1500));
}

/**
 * `GUBBO_SMOKE=voice` with Chromium's fake audio-capture device playing a WAV file: exercises the real
 * hotkey handler → microphone capture → 16 kHz WAV → whisper.cpp → chat path. With no API key stored the
 * turn is blocked before dispatch and the transcript lands back in the composer, where it is read.
 */
async function voiceSmoke(report: Record<string, unknown>): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn: () => boolean | Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(250); } return false; };
  const draft = () => panel!.webContents.executeJavaScript('document.querySelector(".composer textarea")?.value ?? ""') as Promise<string>;
  try {
    await whisper.download(() => {});
    report.micActiveBeforeTalk = avatarState;
    toggleTalk();                                                       // what the global hotkey calls
    report.reachedListening = await until(() => avatarState === 'listening', 15_000);
    report.escapeBoundWhileListening = globalShortcut.isRegistered('Escape');
    await sleep(Number(process.env.GUBBO_SMOKE_RECORD_MS ?? 6000));
    toggleTalk();
    report.gotTranscript = await until(async () => (await draft()).length > 0, 90_000);
    report.transcript = await draft();
    await until(() => avatarState === 'idle', 8000);
    report.stateSequence = stateLog.join(' > ');
    report.escapeReleasedWhenIdle = !globalShortcut.isRegistered('Escape');
    report.requestsRecorded = budget.ledger().length;                   // must be 0: nothing was dispatched without a key
    report.voiceOk = report.reachedListening === true && report.gotTranscript === true && report.requestsRecorded === 0;
  } catch (e) { report.voiceError = String(e); report.voiceOk = false; }
}
