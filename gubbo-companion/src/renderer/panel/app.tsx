import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { shortSpoken, toSpeakable } from '../../main/speechText';
import type { AppStatus, AvatarState, ChatEvent, ChatMessage, ChatMode, Conversation, Settings } from '../../shared/types';
import { call, on } from '../bridge';
import { MicError, Recorder, Speaker } from './voice';

export interface AppInfo { pricingChecked: string; suggestedHotkeys: string[]; whisperModels: { id: string; label: string; mb: number }[]; notesDir: string; neuralVoices: { id: string; label: string }[] }
export type Tab = 'chat' | 'projects' | 'channel' | 'memory' | 'settings';
type ToastKind = 'ok' | 'warn' | 'error';

export interface Chat {
  conversationId: number | null; conversations: Conversation[]; messages: ChatMessage[]; streaming: string | null; toolNotes: string[];
  mode: ChatMode; banner: { text: string; reason: string } | null; draft: string; videoId: number | null;
  setMode(m: ChatMode): void; setDraft(s: string): void;
  send(text: string, opts?: { viaVoice?: boolean; includeAnalytics?: boolean; videoId?: number | null; newConversation?: boolean; mode?: ChatMode }): void;
  open(id: number | null): void; remove(id: number): void;
}

export interface AppCtx {
  settings: Settings; status: AppStatus; info: AppInfo; phase: AvatarState; tab: Tab; chat: Chat; speaker: Speaker;
  patch(p: unknown): void; refreshStatus(): Promise<void>; toast(text: string, kind?: ToastKind): void;
  setTab(t: Tab): void; say(text: string): Promise<void>; readAloud(markdown: string): void;
  voiceToggle(): void; cancelAll(): void; celebrate(): void;
  /** When set, the next finished transcript goes to this handler instead of the chat (used by brain dumps). */
  captureTranscript(fn: ((text: string) => void) | null): void;
}

const Ctx = createContext<AppCtx | null>(null);
export const useApp = () => useContext(Ctx)!;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [phase, setPhaseState] = useState<AvatarState>('idle');
  const [tab, setTab] = useState<Tab>('chat');
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: ToastKind }[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [toolNotes, setToolNotes] = useState<string[]>([]);
  const [mode, setMode] = useState<ChatMode>('conversation');
  const [banner, setBanner] = useState<Chat['banner']>(null);
  const [draft, setDraft] = useState('');
  const [videoId, setVideoId] = useState<number | null>(null);

  const recorder = useRef(new Recorder()).current;
  const speaker = useRef(new Speaker()).current;
  const live = useRef({ phase: 'idle' as AvatarState, turnId: null as string | null, settings: null as Settings | null, conversationId: null as number | null, mode: 'conversation' as ChatMode, pendingText: '', viaVoice: false, capture: null as ((t: string) => void) | null, videoId: null as number | null });
  live.current.settings = settings; live.current.conversationId = conversationId; live.current.mode = mode; live.current.videoId = videoId;

  const setPhase = useCallback((p: AvatarState) => { live.current.phase = p; setPhaseState(p); void call('voice:state', p); }, []);
  const toast = useCallback((text: string, kind: ToastKind = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'ok' ? 4500 : 9000);
  }, []);
  const refreshStatus = useCallback(async () => setStatus(await call<AppStatus>('app:status')), []);
  const patch = useCallback((p: unknown) => { void call<Settings>('settings:set', p).then(setSettings).catch((e) => toast(e.message, 'error')); }, [toast]);
  const loadConversations = useCallback(async () => setConversations(await call<Conversation[]>('chat:conversations')), []);

  /** Speak, unless the microphone is open. Recording and speech never overlap. */
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Caption beside the character. `holdMs` clears it afterwards; 0 keeps it until replaced. */
  const caption = useCallback((text: string | null, kind: 'say' | 'heard' | 'problem' = 'say', holdMs = 0) => {
    if (bubbleTimer.current) { clearTimeout(bubbleTimer.current); bubbleTimer.current = null; }
    void call('bubble:set', text ? { text, kind } : null);
    if (text && holdMs) bubbleTimer.current = setTimeout(() => void call('bubble:set', null), holdMs);
  }, []);
  const say = useCallback(async (text: string, kind: 'say' | 'problem' = 'say') => {
    const s = live.current.settings;
    if (!s || !text || recorder.recording) return;
    setPhase('speaking');
    const finished = await speaker.speak(text, s.voice, (part) => caption(part, kind));
    if (finished) caption(text.length > 160 ? null : text, kind, 3500); else if (!recorder.recording) caption(null);
    if (live.current.phase === 'speaking') setPhase('idle');
  }, [recorder, speaker, setPhase, caption]);
  const readAloud = useCallback((md: string) => { void say(toSpeakable(md)); }, [say]);

  const flashError = useCallback(() => { setPhase('error'); setTimeout(() => { if (live.current.phase === 'error') setPhase('idle'); }, 2500); }, [setPhase]);
  const celebrate = useCallback(() => { if (live.current.phase === 'idle') { setPhase('celebrating'); setTimeout(() => { if (live.current.phase === 'celebrating') setPhase('idle'); }, 1800); } }, [setPhase]);

  const send: Chat['send'] = useCallback((text, opts = {}) => {
    const body = text.trim();
    if (!body || live.current.turnId) return;
    speaker.stop();
    const turnId = crypto.randomUUID();
    live.current.turnId = turnId; live.current.pendingText = body; live.current.viaVoice = !!opts.viaVoice;
    const cid = opts.newConversation ? null : live.current.conversationId;
    if (opts.newConversation) { setConversationId(null); setMessages([]); }
    if (opts.mode) setMode(opts.mode);
    if (opts.videoId !== undefined) setVideoId(opts.videoId);
    setBanner(null); setStreaming(''); setToolNotes([]); setDraft('');
    setMessages((m) => [...(opts.newConversation ? [] : m), { id: -1, conversationId: cid ?? 0, role: 'user', text: body, model: null, createdAt: new Date().toISOString(), meta: { viaVoice: opts.viaVoice } }]);
    setPhase('thinking');
    call('chat:send', { turnId, conversationId: cid, text: body, mode: opts.mode ?? live.current.mode, viaVoice: !!opts.viaVoice, includeAnalytics: !!opts.includeAnalytics, videoId: opts.videoId ?? live.current.videoId })
      .catch((e) => { live.current.turnId = null; setStreaming(null); setBanner({ text: e.message, reason: 'error' }); flashError(); });
  }, [speaker, setPhase, flashError]);

  const onChatEvent = useCallback((ev: ChatEvent) => {
    if (ev.turnId !== live.current.turnId) return;
    if (ev.type === 'text') { setStreaming((s) => (s ?? '') + ev.delta); return; }
    if (ev.type === 'tool') { setToolNotes((n) => [...n, ev.note]); return; }
    if (ev.type === 'start') return;
    live.current.turnId = null;
    setStreaming(null);
    const settle = (user?: ChatMessage, assistant?: ChatMessage) => {
      setMessages((m) => [...m.filter((x) => x.id !== -1), ...(user ? [user] : []), ...(assistant ? [assistant] : [])]);
      const cid = user?.conversationId ?? assistant?.conversationId;
      if (cid) setConversationId(cid);
      void loadConversations();
    };
    if (ev.type === 'done') {
      settle(ev.userMessage, ev.message);
      if (ev.message.meta.toolNotes?.some((n) => /^(Saved|Remembered|Scored)/.test(n))) void refreshStatus();
      // A spoken question gets its whole answer spoken; a typed one gets the short version (the rest is on screen).
      const full = toSpeakable(ev.message.text);
      const spoken = live.current.viaVoice && ev.message.role !== 'local' ? (full.length > 1800 ? `${shortSpoken(ev.message.text, 1500)}` : full) : ev.speak;
      if (live.current.settings?.voice.speakReplies) void say(spoken); else { caption(shortSpoken(ev.message.text, 260), 'say', 9000); setPhase('idle'); }
    } else if (ev.type === 'cancelled') {
      settle(ev.userMessage, ev.message);
      if (!ev.userMessage) setDraft(live.current.pendingText);
      setPhase('idle');
    } else {
      // Blocked before or during the request: keep the user's words so nothing is lost.
      if (ev.userMessage) settle(ev.userMessage); else { setMessages((m) => m.filter((x) => x.id !== -1)); setDraft(live.current.pendingText); }
      setBanner({ text: ev.message, reason: ev.reason });
      void refreshStatus();
      flashError();
      const brief = shortSpoken(ev.message, 220);
      caption(brief, 'problem', 12000);
      if (live.current.viaVoice && live.current.settings?.voice.speakReplies) void speaker.speak(brief, live.current.settings.voice);
    }
  }, [loadConversations, refreshStatus, say, setPhase, flashError, speaker]);

  const cancelAll = useCallback(() => {
    recorder.cancel(); speaker.stop(); caption(null);
    if (live.current.turnId) void call('chat:cancel', live.current.turnId);
    if (live.current.phase !== 'thinking' || !live.current.turnId) setPhase('idle');
  }, [recorder, speaker, setPhase]);

  const stopAndTranscribe = useCallback(async () => {
    setPhase('transcribing');
    try {
      const wav = await recorder.stop();           // microphone is released here, before anything else happens
      const text = await call<string | null>('voice:transcribe', wav);
      if (text === null) { setPhase('idle'); return; }              // cancelled with Esc
      if (!text) { toast('I didn’t catch any words. Try again.', 'warn'); caption('I didn’t catch that — try again.', 'problem', 5000); flashError(); return; }
      caption(`“${text}”`, 'heard');
      const capture = live.current.capture;
      if (capture) { setPhase('idle'); capture(text); return; }
      send(text, { viaVoice: true });
    } catch (e) {
      if (live.current.phase !== 'transcribing') return;             // cancelled meanwhile
      toast((e as Error).message, e instanceof MicError && e.kind === 'silence' ? 'warn' : 'error');
      caption((e as Error).message, 'problem', 9000);
      flashError();
    }
  }, [recorder, send, setPhase, toast, flashError, caption]);

  const voiceToggle = useCallback(async () => {
    const p = live.current.phase;
    if (recorder.recording) { void stopAndTranscribe(); return; }
    if (p === 'transcribing' || p === 'thinking') { toast('Still working on the last one — press Esc to cancel it.', 'warn'); return; }
    speaker.stop();                                // never listen to our own voice
    const w = await call('whisper:status');
    if (!w.binaryReady || !w.modelReady) { toast('Voice input isn’t set up yet. Download speech recognition in Settings → Voice, or type instead.', 'warn'); caption('I can’t hear you yet — speech recognition needs a one-time download. I’ve opened Settings.', 'problem', 9000); setTab('settings'); void call('panel:show', 'settings'); setPhase('idle'); return; }
    try {
      await recorder.start(live.current.settings?.voice.micDeviceId ?? null);
      caption(null);
      setPhase('listening');
    } catch (e) { toast((e as Error).message, 'error'); caption((e as Error).message, 'problem', 10000); flashError(); }
  }, [recorder, speaker, stopAndTranscribe, setPhase, toast, flashError]);

  const open = useCallback(async (id: number | null) => {
    if (live.current.turnId) return;
    setConversationId(id); setBanner(null); setVideoId(null);
    if (id === null) { setMessages([]); return; }
    setMessages(await call<ChatMessage[]>('chat:messages', id));
    const c = (await call<Conversation[]>('chat:conversations')).find((x) => x.id === id);
    if (c) { setMode(c.mode); setVideoId(c.videoId); }
  }, []);
  const remove = useCallback(async (id: number) => { await call('chat:delete', id); if (live.current.conversationId === id) { setConversationId(null); setMessages([]); } void loadConversations(); }, [loadConversations]);

  useEffect(() => {
    void Promise.all([call<Settings>('settings:get'), call<AppStatus>('app:status'), call<AppInfo>('app:info')]).then(async ([s, st, i]) => {
      setSettings(s); setStatus(st); setInfo(i);
      const convs = await call<Conversation[]>('chat:conversations'); setConversations(convs);
      // Pick up where the last session ended.
      if (convs[0]) { setConversationId(convs[0].id); setMode(convs[0].mode); setVideoId(convs[0].videoId); setMessages(await call<ChatMessage[]>('chat:messages', convs[0].id)); }
      live.current.settings = s;
      const b = await call<{ ok: boolean; text: string } | null>('panel:ready');
      if (b?.ok) { if (s.voice.speakReplies) void say(b.text); else caption(shortSpoken(b.text, 260), 'say', 12000); }
      else if (s.setupDone && s.companion.minimal) {
        const key = st.hotkey.accelerator.replace('Control', 'Ctrl').replace(/\+/g, ' + ');
        caption(st.budget.state === 'ok' ? `Press ${key} and talk to me.` : 'I’m not fully set up yet — click me to finish.', st.budget.state === 'ok' ? 'say' : 'problem', 9000);
      }
    });
    recorder.onLost = () => { toast('The microphone was disconnected. Recording stopped.', 'error'); recorder.cancel(); flashError(); };
    const offs = [
      on('chat:event', (e) => onChatRef.current(e)), on('voice:toggle', () => toggleRef.current()), on('voice:cancel', () => cancelRef.current()),
      on('settings:changed', setSettings), on('nav', (t: Tab) => setTab(t)), on('skin:changed', () => void refreshStatus()),
    ];
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && live.current.phase !== 'idle') cancelRef.current(); };
    window.addEventListener('keydown', esc);
    return () => { offs.forEach((f) => f()); window.removeEventListener('keydown', esc); };
  }, []);
  const onChatRef = useRef(onChatEvent); onChatRef.current = onChatEvent;
  const toggleRef = useRef(voiceToggle); toggleRef.current = voiceToggle;
  const cancelRef = useRef(cancelAll); cancelRef.current = cancelAll;

  if (!settings || !status || !info) return <div className="loading">Starting…</div>;
  const chat: Chat = { conversationId, conversations, messages, streaming, toolNotes, mode, banner, draft, videoId, setMode, setDraft, send, open, remove };
  const ctx: AppCtx = { settings, status, info, phase, tab, chat, speaker, patch, refreshStatus, toast, setTab, say, readAloud, voiceToggle, cancelAll, celebrate, captureTranscript: (fn) => { live.current.capture = fn; } };
  return (
    <Ctx.Provider value={ctx}>
      {children}
      <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>{t.text}</div>)}</div>
    </Ctx.Provider>
  );
}
