// Settings sections. The same components are used by the first-run setup wizard and the Settings tab.
import { useEffect, useRef, useState } from 'react';
import type { AppStatus, BudgetConfig, BudgetStatus, ContextDoc, LedgerEntry, ModelInfo, Settings, WhisperStatus } from '../../shared/types';
import { call, on } from '../bridge';
import { useApp } from './app';
import { listVoices } from './voice';

export const Link = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} onClick={(e) => { e.preventDefault(); void call('external:open', href); }}>{children}</a>
);
export const Row = ({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) => (
  <label className="row"><span className="row-label">{label}{hint && <small>{hint}</small>}</span><span className="row-control">{children}</span></label>
);
const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`);

// ------------------------------------------------------------------ character

export function CharacterSection() {
  const { settings, patch, status, refreshStatus, toast } = useApp();
  const a = settings.avatar;
  const [username, setUsername] = useState('');
  const importSkin = async () => {
    try { const s = await call('skin:import'); if (s) { toast(s.legacy ? 'Skin imported (older 64×32 format).' : 'Skin imported.', 'ok'); await refreshStatus(); } }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <section>
      <h3>Character</h3>
      <p className="muted">The character uses your real Minecraft skin file — the small PNG texture, not a screenshot or profile picture. You can download it from minecraft.net (Profile → Skin) or find it in your launcher.</p>
      <div className="inline">
        <button className="primary" onClick={importSkin}>{status.skin.imported ? 'Replace skin…' : 'Import skin…'}</button>
        {status.skin.imported
          ? <><span className="pill ok">{status.skin.label}{status.skin.legacy ? ' (legacy 64×32)' : ''}</span>{status.skin.source === 'custom' && <button onClick={async () => { await call('skin:remove'); await refreshStatus(); }}>Back to the built-in Gubbo skin</button>}</>
          : <span className="pill warn">Showing a placeholder — not your skin</span>}
      </div>
      {status.skin.source === 'bundled' && <p className="muted">This is the skin currently set on the Minecraft account <b>GubboYT</b>, which matches your channel picture. If you change your skin, update it here.</p>}
      <div className="inline">
        <input placeholder="Minecraft username" value={username} maxLength={16} onChange={(e) => setUsername(e.target.value)} />
        <button disabled={username.trim().length < 3} onClick={async () => { try { const s = await call('skin:fromUsername', username); toast(`Loaded the skin from ${s.label}.`, 'ok'); setUsername(''); await refreshStatus(); } catch (e) { toast((e as Error).message, 'error'); } }}>Get skin from Minecraft</button>
      </div>
      {status.skin.imported && (
        <Row label="Arm type" hint="Auto-detect reads it from the texture.">
          <select value={status.skin.model} onChange={async (e) => { await call('skin:model', e.target.value); await refreshStatus(); }}>
            <option value="auto-detect">Auto-detect</option><option value="default">Classic (4-pixel arms)</option><option value="slim">Slim (3-pixel arms)</option>
          </select>
        </Row>
      )}
      <Row label="Size"><input type="range" min={120} max={480} step={10} value={a.size} onChange={(e) => patch({ avatar: { size: Number(e.target.value) } })} /></Row>
      <Row label="Show the character"><input type="checkbox" checked={a.visible} onChange={(e) => patch({ avatar: { visible: e.target.checked } })} /></Row>
      <Row label="Keep on top of other windows"><input type="checkbox" checked={a.alwaysOnTop} onChange={(e) => patch({ avatar: { alwaysOnTop: e.target.checked } })} /></Row>
      <Row label="Reduced motion"><input type="checkbox" checked={a.reducedMotion} onChange={(e) => patch({ avatar: { reducedMotion: e.target.checked } })} /></Row>
      <p className="muted">Drag the character anywhere. Click it to open this panel; right-click for the menu.</p>
    </section>
  );
}

// ------------------------------------------------------------------ shortcut

function accelFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Control'); if (e.altKey) mods.push('Alt'); if (e.shiftKey) mods.push('Shift'); if (e.metaKey) mods.push('Super');
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else if (e.code === 'Space') key = 'Space';
  if (!key) return null;
  return [...mods, key].join('+');
}

export function ShortcutSection() {
  const { settings, patch, status, refreshStatus, info } = useApp();
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(status.hotkey.error);
  const apply = async (acc: string) => {
    try { const r = await call('hotkey:set', acc); setError(r.ok ? null : r.error); await refreshStatus(); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => {
    if (!capturing) return;
    const fn = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(false); return; }
      const acc = accelFromEvent(e);
      if (acc) { setCapturing(false); void apply(acc); }
    };
    window.addEventListener('keydown', fn, true);
    return () => window.removeEventListener('keydown', fn, true);
  }, [capturing]);
  const pretty = (s: string) => s.replace('Control', 'Ctrl').replace(/\+/g, ' + ');
  return (
    <section>
      <h3>Shortcut</h3>
      <div className="inline">
        <kbd className="big">{pretty(status.hotkey.accelerator || settings.hotkey)}</kbd>
        {status.hotkey.registered ? <span className="pill ok">Active</span> : <span className="pill bad">Not active</span>}
        <button onClick={() => setCapturing(true)}>{capturing ? 'Press the new shortcut… (Esc to cancel)' : 'Change…'}</button>
      </div>
      {error && <div className="notice bad">{error}<div className="inline wrap">{info.suggestedHotkeys.filter((h) => h !== status.hotkey.accelerator).map((h) => <button key={h} onClick={() => apply(h)}>Try {pretty(h)}</button>)}</div></div>}
      <ul className="muted tight">
        <li>Press once from any app: Gubbo appears, stops talking, and starts listening.</li>
        <li>Press again: your words are transcribed and sent.</li>
        <li>Esc cancels listening, thinking or speaking. Esc is only captured while one of those is happening.</li>
      </ul>
      <Row label="Just Gubbo" hint="Pressing the shortcut shows only the character: you talk, he answers out loud. The panel stays hidden until you click him.">
        <input type="checkbox" checked={settings.companion.minimal} onChange={(e) => patch({ companion: { minimal: e.target.checked } })} />
      </Row>
      <Row label="Captions beside Gubbo" hint="Shows what he heard and what he is saying.">
        <input type="checkbox" checked={settings.companion.captions} onChange={(e) => patch({ companion: { captions: e.target.checked } })} />
      </Row>
      <Row label="Start with Windows" hint="The shortcut only works while Gubbo Companion is running — it cannot start an app that has been quit.">
        <input type="checkbox" checked={settings.launchAtLogin} onChange={(e) => patch({ launchAtLogin: e.target.checked })} />
      </Row>
    </section>
  );
}

// ------------------------------------------------------------------ voice

export function VoiceSection() {
  const { settings, patch, speaker, toast, voiceToggle, phase } = useApp();
  const v = settings.voice;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [w, setW] = useState<WhisperStatus | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number; step: string } | null>(null);
  const [tts, setTts] = useState<{ downloaded: boolean; downloadBytes: number; error: string | null } | null>(null);
  const [ttsProgress, setTtsProgress] = useState<{ received: number; total: number; step: string } | null>(null);
  const { info } = useApp();
  const downloadVoice = async () => {
    setTtsProgress({ received: 0, total: tts?.downloadBytes ?? 1, step: 'Starting…' });
    try { setTts(await call('tts:prepare')); toast('The natural voice is ready.', 'ok'); }
    catch (e) { toast((e as Error).message, 'error'); setTts(await call('tts:status')); } finally { setTtsProgress(null); }
  };
  const loadMics = () => navigator.mediaDevices.enumerateDevices().then((d) => setMics(d.filter((x) => x.kind === 'audioinput'))).catch(() => setMics([]));
  useEffect(() => {
    void listVoices().then((all) => setVoices(all.filter((x) => x.localService)));
    void call<WhisperStatus>('whisper:status').then(setW);
    void loadMics();
    navigator.mediaDevices.addEventListener('devicechange', loadMics);
    void call('tts:status').then(setTts);
    const off = on('whisper:progress', setProgress);
    const off2 = on('tts:progress', setTtsProgress);
    return () => { navigator.mediaDevices.removeEventListener('devicechange', loadMics); off(); off2(); };
  }, [v.whisperModel]);
  const download = async () => {
    try { setProgress({ received: 0, total: w?.downloadBytes ?? 1, step: 'Starting…' }); setW(await call('whisper:download')); toast('Speech recognition is ready.', 'ok'); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setProgress(null); }
  };
  const mb = (b: number) => `${Math.round(b / 1e6)} MB`;
  return (
    <section>
      <h3>Voice</h3>
      <h4>Listening (speech to text)</h4>
      {w && (
        <>
          <p className="muted">{w.note} This PC: {w.cpu}, {w.cores} threads, {w.memGb} GB memory.</p>
          <Row label="Speech model" hint={`Recommended for this PC: ${w.recommended}`}>
            <select value={v.whisperModel} onChange={(e) => patch({ voice: { whisperModel: e.target.value } })}>
              {info.whisperModels.map((m) => <option key={m.id} value={m.id}>{m.id} — {m.label}, {m.mb} MB</option>)}
            </select>
          </Row>
          {w.binaryReady && w.modelReady
            ? <div className="inline"><span className="pill ok">Ready</span><button onClick={voiceToggle} disabled={phase !== 'idle' && phase !== 'listening'}>{phase === 'listening' ? 'Stop and transcribe' : 'Test the microphone'}</button></div>
            : w.platformSupported
              ? progress
                ? <div><progress value={progress.received} max={progress.total} /> <span className="muted">{progress.step} — {mb(progress.received)} of {mb(progress.total)}</span> <button onClick={() => call('whisper:cancel')}>Cancel</button></div>
                : <div className="inline"><button className="primary" onClick={download}>Download speech recognition ({mb(w.downloadBytes)}, one time)</button><span className="muted">From the official whisper.cpp release and model repository, checksum-verified.</span></div>
              : <span className="pill warn">Not available on this system — typing still works</span>}
        </>
      )}
      <Row label="Microphone" hint="The microphone is only on while you are recording.">
        <select value={v.micDeviceId ?? ''} onChange={(e) => patch({ voice: { micDeviceId: e.target.value || null } })}>
          <option value="">Windows default</option>
          {mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((m, i) => <option key={m.deviceId} value={m.deviceId}>{m.label || `Microphone ${i + 1}`}</option>)}
        </select>
      </Row>
      <h4>Speaking</h4>
      <Row label="Voice type" hint="The natural voice is generated on this PC by a free open model (Kokoro). Nothing is sent anywhere and it costs nothing.">
        <select value={v.engine} onChange={(e) => patch({ voice: { engine: e.target.value } })}>
          <option value="neural">Natural voice (recommended)</option><option value="windows">Windows built-in voice</option>
        </select>
      </Row>
      {v.engine === 'neural' && tts && (
        <>
          {tts.downloaded
            ? <Row label="Voice" hint="Try a few — Fenrir, Onyx and Lewis are the deeper ones.">
                <select value={v.neuralVoice} onChange={(e) => patch({ voice: { neuralVoice: e.target.value } })}>
                  {info.neuralVoices.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </select>
              </Row>
            : ttsProgress
              ? <div><progress value={ttsProgress.received} max={ttsProgress.total} /> <span className="muted">{ttsProgress.step} — {mb(ttsProgress.received)} of {mb(ttsProgress.total)}</span></div>
              : <div className="inline"><button className="primary" onClick={downloadVoice}>Download the natural voice ({mb(tts.downloadBytes)}, one time)</button><span className="muted">Until then Gubbo uses a Windows voice.</span></div>}
          {tts.error && <p className="notice bad">{tts.error}</p>}
        </>
      )}
      {v.engine === 'windows' && (voices.length === 0
        ? <p className="notice warn">No installed voices were found. Add one in Windows Settings → Time & language → Speech. Replies will still appear as captions.</p>
        : <><Row label="Voice">
            <select value={v.voiceName ?? ''} onChange={(e) => patch({ voice: { voiceName: e.target.value || null } })}>
              <option value="">Default English voice</option>
              {voices.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.lang})</option>)}
            </select>
          </Row>
          <Row label={`Pitch ${v.pitch.toFixed(2)}`} hint="Lower is deeper."><input type="range" min={0.3} max={1.6} step={0.05} value={v.pitch} onChange={(e) => patch({ voice: { pitch: Number(e.target.value) } })} /></Row></>)}
      <Row label={`Speed ${v.rate.toFixed(2)}×`}><input type="range" min={0.6} max={1.8} step={0.05} value={v.rate} onChange={(e) => patch({ voice: { rate: Number(e.target.value) } })} /></Row>
      <Row label={`Volume ${Math.round(v.volume * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={v.volume} onChange={(e) => patch({ voice: { volume: Number(e.target.value) } })} /></Row>
      <div className="inline">
        <button onClick={() => speaker.speak('Hey Gavin. This is how I sound. Want to plan the next video?', v)}>Preview voice</button>
        <button onClick={() => speaker.stop()}>Stop</button>
      </div>
      <Row label="Speak replies aloud" hint="Short answer spoken; the full reply stays in the panel with a Read aloud button."><input type="checkbox" checked={v.speakReplies} onChange={(e) => patch({ voice: { speakReplies: e.target.checked } })} /></Row>
    </section>
  );
}

// ------------------------------------------------------------------ Claude key + models

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function ClaudeSection() {
  const { settings, patch, status, refreshStatus, toast, info } = useApp();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => { void call<ModelInfo[]>('models:list').then(setModels); }, [status.hasApiKey]);
  const save = async () => {
    setBusy(true);
    try { await call('key:set', key); setKey(''); await refreshStatus(); toast('Key stored with Windows protection.', 'ok'); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const modelSelect = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {models.map((m) => <option key={m.id} value={m.id}>{m.name} — ${m.inputPerMTok} in / ${m.outputPerMTok} out per million tokens{m.available === false ? ' — not available to this key' : ''}</option>)}
    </select>
  );
  const unavailable = (id: string) => models.find((m) => m.id === id)?.available === false;
  return (
    <section>
      <h3>Claude</h3>
      <p className="muted">Gubbo’s thinking runs on the Claude API, paid from the API credit included with your Claude subscription. This is separate from Claude Code and the Claude apps — an API key does not give access to your claude.ai chats or Projects.</p>
      <ol className="steps">
        <li>In Claude, open <Link href="https://claude.ai/settings/billing">Settings → Billing</Link> and claim the included API credit by linking a Console organization (Max and Ultra plans; check what yours shows).</li>
        <li>In the <Link href="https://platform.claude.com/settings/workspaces">Claude Console</Link>, create a workspace called “Gubbo Companion”, then <Link href="https://platform.claude.com/settings/keys">create an API key</Link> in that workspace.</li>
        <li>Paste the key below. It is checked, encrypted by Windows, and never shown again.</li>
      </ol>
      {!status.secureStorage && <p className="notice bad">Windows credential protection is not available in this session, so a key cannot be stored.</p>}
      <div className="inline">
        <input type="password" autoComplete="off" spellCheck={false} placeholder={status.hasApiKey ? 'A key is stored — paste a new one to replace it' : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} className="grow" />
        <button className="primary" disabled={!key.trim() || busy || !status.secureStorage} onClick={save}>{busy ? 'Checking…' : 'Save key'}</button>
        {status.hasApiKey && <button onClick={async () => { await call('key:clear'); await refreshStatus(); }}>Remove key</button>}
      </div>
      <h4>Models</h4>
      <Row label="Conversation">{modelSelect(settings.ai.conversationModel, (v) => patch({ ai: { conversationModel: v } }))}</Row>
      <Row label="Conversation effort"><select value={settings.ai.conversationEffort} onChange={(e) => patch({ ai: { conversationEffort: e.target.value } })}>{EFFORTS.map((x) => <option key={x}>{x}</option>)}</select></Row>
      <Row label="Deep brainstorm">{modelSelect(settings.ai.deepModel, (v) => patch({ ai: { deepModel: v } }))}</Row>
      <Row label="Deep brainstorm effort"><select value={settings.ai.deepEffort} onChange={(e) => patch({ ai: { deepEffort: e.target.value } })}>{EFFORTS.map((x) => <option key={x}>{x}</option>)}</select></Row>
      {(unavailable(settings.ai.conversationModel) || unavailable(settings.ai.deepModel)) && <p className="notice warn">A selected model is not available to this key. Gubbo will not quietly switch to another one — choose a model marked as available.</p>}
      <p className="muted">Prices checked {info.pricingChecked}. Gubbo never swaps models on its own; if a model declines or is unavailable you are told and you choose.</p>
      <Row label="Web research" hint={`Uses Claude’s web search: $0.01 per search plus the tokens of what it reads, counted in the budget. Up to ${settings.ai.maxSearchesPerTurn} searches per reply.`}>
        <input type="checkbox" checked={settings.ai.webResearch} onChange={(e) => patch({ ai: { webResearch: e.target.checked } })} />
      </Row>
      {settings.ai.webResearch && <Row label="Searches per reply"><input type="number" min={1} max={5} value={settings.ai.maxSearchesPerTurn} onChange={(e) => patch({ ai: { maxSearchesPerTurn: Number(e.target.value) } })} /></Row>}
      <Row label="Keep conversation history" hint="When off, conversations are erased each time the app closes."><input type="checkbox" checked={settings.history.saveTranscripts} onChange={(e) => patch({ history: { saveTranscripts: e.target.checked } })} /></Row>
    </section>
  );
}

// ------------------------------------------------------------------ budget

interface BudgetData { status: BudgetStatus; config: BudgetConfig; ledger: LedgerEntry[] }

export function BudgetSection() {
  const { refreshStatus, toast } = useApp();
  const [d, setD] = useState<BudgetData | null>(null);
  const [f, setF] = useState({ allowance: '', expires: '', reserve: '5', cap: '', autoReloadOff: false, onlyIncluded: false, workspaceLimit: false });
  const [fix, setFix] = useState<{ id: number; value: string } | null>(null);
  const load = async () => {
    const x = await call<BudgetData>('budget:status'); setD(x);
    setF((p) => ({ ...p, allowance: x.config.allowanceUsd?.toString() ?? '', expires: x.config.expiresAt ? x.config.expiresAt.slice(0, 16) : '', reserve: String(x.config.reserveUsd), cap: x.config.monthlyCapUsd?.toString() ?? '', autoReloadOff: x.config.spendingVerified, onlyIncluded: x.config.spendingVerified }));
  };
  useEffect(() => { void load(); }, []);
  if (!d) return null;
  const save = async () => {
    try {
      const x = await call<BudgetData>('budget:verify', { allowanceUsd: Number(f.allowance), expiresAt: f.expires ? new Date(f.expires).toISOString() : null, reserveUsd: Number(f.reserve || 0), monthlyCapUsd: f.cap === '' ? null : Number(f.cap), spendingVerified: f.autoReloadOff && f.onlyIncluded });
      setD(x); await refreshStatus(); toast(x.status.state === 'ok' ? 'Budget confirmed. Cloud requests are on.' : x.status.message, x.status.state === 'ok' ? 'ok' : 'warn');
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const resolve = async (id: number, actual: number | null) => { try { setD(await call('budget:resolve', { id, actualUsd: actual })); await refreshStatus(); } catch (e) { toast((e as Error).message, 'error'); } };
  const s = d.status;
  return (
    <section>
      <h3>Budget — no extra spending</h3>
      <div className={`notice ${s.state === 'ok' ? 'ok' : 'warn'}`}>{s.message}</div>
      <div className="stats">
        <div><b>{money(s.allowanceUsd)}</b><span>credit you entered</span></div>
        <div><b>{money(s.settledUsd)}</b><span>estimated app usage since then</span></div>
        <div><b>{money(s.heldUsd)}</b><span>held (in flight or unresolved)</span></div>
        <div><b>{money(s.remainingUsd)}</b><span>free to use, after the reserve</span></div>
      </div>
      <p className="muted">These are this app’s own estimates, not your organization’s balance. Anything else using the same Console organization also draws on the credit, and an API key cannot read the balance — so re-enter the figure from the Console whenever you check it.</p>
      <h4>Confirm in the Console (<Link href="https://platform.claude.com/settings/billing">Billing</Link>)</h4>
      <label className="check"><input type="checkbox" checked={f.autoReloadOff} onChange={(e) => setF({ ...f, autoReloadOff: e.target.checked })} /> Auto-reload is <b>off</b>, and I have not added a payment method or invoicing for this.</label>
      <label className="check"><input type="checkbox" checked={f.onlyIncluded} onChange={(e) => setF({ ...f, onlyIncluded: e.target.checked })} /> The only credit in this organization is the included subscription credit (no purchased credits).</label>
      <label className="check"><input type="checkbox" checked={f.workspaceLimit} onChange={(e) => setF({ ...f, workspaceLimit: e.target.checked })} /> Recommended: I set a monthly spend limit on the “Gubbo Companion” workspace (<Link href="https://platform.claude.com/settings/limits">Limits</Link>).</label>
      {(!f.autoReloadOff || !f.onlyIncluded) && <p className="notice warn">If the organization has purchased credits, invoicing or auto-reload, requests can spend real money after the included credit runs out, and this app’s local estimate cannot prove otherwise. Cloud requests stay off until both boxes are ticked.</p>}
      <Row label="Credit available now ($)" hint="Exactly as the Console shows it."><input type="number" min={0} step="0.01" value={f.allowance} onChange={(e) => setF({ ...f, allowance: e.target.value })} /></Row>
      <Row label="Credit expires" hint="The date the Console shows. It may not be the end of the calendar month."><input type="datetime-local" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></Row>
      <Row label="Keep in reserve ($)" hint="Never spent by this app."><input type="number" min={0} step="0.5" value={f.reserve} onChange={(e) => setF({ ...f, reserve: e.target.value })} /></Row>
      <Row label="App cap per calendar month ($)" hint="Optional."><input type="number" min={0} step="1" value={f.cap} placeholder="none" onChange={(e) => setF({ ...f, cap: e.target.value })} /></Row>
      <div className="inline"><button className="primary" disabled={f.allowance === ''} onClick={save}>Confirm budget</button>{s.verifiedAt && <span className="muted">Last confirmed {new Date(s.verifiedAt).toLocaleString()}</span>}</div>
      {d.ledger.length > 0 && (
        <details open={d.ledger.some((l) => l.status === 'uncertain')}>
          <summary>Recent requests ({d.ledger.length})</summary>
          <table className="ledger"><thead><tr><th>When</th><th>What</th><th>Model</th><th>Reserved</th><th>Estimated cost</th><th>Status</th></tr></thead>
            <tbody>{d.ledger.map((l) => (
              <tr key={l.id} className={l.status}>
                <td>{new Date(l.createdAt).toLocaleString()}</td><td>{l.purpose}</td><td>{l.model.replace('claude-', '')}</td><td>{money(l.reservedUsd)}</td>
                <td>{l.status === 'settled' ? `$${(l.actualUsd ?? 0).toFixed(4)}` : l.status === 'released' ? '$0 (not billed)' : '?'}</td>
                <td>{l.status === 'uncertain'
                  ? <span title={l.note ?? ''}>Held — charge unknown. <button onClick={() => resolve(l.id, null)}>Count full amount</button> {fix?.id === l.id
                    ? <><input type="number" min={0} step="0.0001" placeholder="$ from Console" value={fix.value} onChange={(e) => setFix({ id: l.id, value: e.target.value })} /> <button disabled={fix.value === ''} onClick={() => { void resolve(l.id, Number(fix.value)); setFix(null); }}>Save</button></>
                    : <button onClick={() => setFix({ id: l.id, value: '' })}>Enter actual…</button>}</span>
                  : l.status}</td>
              </tr>))}</tbody></table>
        </details>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ Gubbo project connection

interface GubboData { docs: ContextDoc[]; settings: Settings['gubbo'] }

export function GubboSection() {
  const { toast, info } = useApp();
  const [d, setD] = useState<GubboData | null>(null);
  const [paste, setPaste] = useState<{ title: string; text: string } | null>(null);
  useEffect(() => { void call<GubboData>('gubbo:list').then(setD); }, []);
  if (!d) return null;
  const run = async (channel: string, payload?: unknown, done?: (r: any) => string | null) => {
    try { const r = await call(channel, payload); if (!r) return; if (r.docs) setD({ docs: r.docs, settings: r.settings }); const m = done?.(r); if (m) toast(m, 'ok'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const folderDocs = d.docs.filter((x) => x.source === 'folder'), imports = d.docs.filter((x) => x.source === 'import');
  return (
    <section>
      <h3>Your Gubbo project</h3>
      <p className="muted">Gubbo Companion can read your existing Gubbo material so it starts with your rules and history. Pick whichever matches where Gubbo lives:</p>
      <div className="cards">
        <div className={`card ${d.settings.mode === 'folder' ? 'sel' : ''}`}>
          <h4>It’s a folder on this PC</h4>
          <p className="muted">The folder is read in place and re-checked for changes. New notes Gubbo writes go into a “{info.notesDir}” subfolder; your files are never changed.</p>
          {d.settings.folder
            ? <><p><code>{d.settings.folder}</code></p><p className="muted">{folderDocs.length} files indexed{d.settings.lastFolderScan ? `, last checked ${new Date(d.settings.lastFolderScan).toLocaleString()}` : ''}.</p>
                <div className="inline"><button onClick={() => run('gubbo:rescan', undefined, (r) => r.scan.error ?? `Checked: ${r.scan.updated} updated, ${r.scan.removed} removed.`)}>Check for changes</button><button onClick={() => run('gubbo:chooseFolder')}>Change folder…</button><button onClick={() => run('gubbo:disconnectFolder')}>Disconnect</button></div></>
            : <button className="primary" onClick={() => run('gubbo:chooseFolder', undefined, (r) => r.scan.error ?? `Indexed ${r.scan.indexed} files.`)}>Use a local folder…</button>}
        </div>
        <div className={`card ${d.settings.mode === 'import' ? 'sel' : ''}`}>
          <h4>It’s a Project inside Claude</h4>
          <p className="muted">There is no supported way for an app to read a claude.ai Project directly, so this is a one-way import — not live sync. In Claude, open the Gubbo project, copy its instructions and download or copy its knowledge files, then bring them in here. Ask Claude there to “summarise our key decisions” to carry over chat history. (Claude’s full data export does not include original uploaded files.)</p>
          <div className="inline wrap">
            <button className="primary" onClick={() => run('gubbo:importFiles', undefined, (r) => `Imported ${r.result.imported.length} file(s)${r.result.rejected.length ? `; skipped ${r.result.rejected.map((x: any) => `${x.file} (${x.why})`).join('; ')}` : ''}.`)}>Import files…</button>
            <button onClick={() => setPaste({ title: 'Gubbo project instructions', text: '' })}>Paste text…</button>
            <button disabled={!imports.length} onClick={() => run('gubbo:refreshImports', undefined, (r) => `Re-read ${r.result.refreshed} file(s)${r.result.missing.length ? `; originals missing for ${r.result.missing.join(', ')} (kept the saved copy)` : ''}.`)}>Refresh imported context</button>
          </div>
        </div>
      </div>
      {paste && (
        <div className="card">
          <input className="grow" value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} placeholder="Title" />
          <textarea rows={8} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder="Paste the project instructions or a conversation summary here" />
          <div className="inline"><button className="primary" disabled={!paste.text.trim()} onClick={async () => { await run('gubbo:importPasted', paste, () => 'Imported.'); setPaste(null); }}>Import</button><button onClick={() => setPaste(null)}>Cancel</button></div>
        </div>
      )}
      {imports.length > 0 && (
        <details open><summary>Imported context ({imports.length}) — copies taken at the time shown</summary>
          <ul className="list">{imports.map((x) => <li key={x.id}><b>{x.title}</b> <span className="muted">{Math.round(x.chars / 1000)}k characters · imported {new Date(x.importedAt).toLocaleString()} · from {x.path.startsWith('pasted:') ? 'pasted text' : x.path}</span> <button onClick={() => run('gubbo:remove', x.id)}>Remove</button></li>)}</ul>
        </details>
      )}
      <div className="inline">
        <button onClick={() => run('gubbo:export', undefined, (p) => `Saved to ${p}. Add it to the Gubbo project’s knowledge in Claude.`)}>Export for Gubbo…</button>
        <span className="muted">Writes your decisions, scores, sources and documents to one Markdown file you can add back to the Claude project.</span>
      </div>
      {d.settings.mode === 'unset' && <button onClick={async () => setD({ ...d, settings: await call('gubbo:later') })}>Set this up later</button>}
    </section>
  );
}

// ------------------------------------------------------------------ rules, data

export function RulesSection() {
  const { settings, patch } = useApp();
  const [r, setR] = useState(settings.rules);
  const dirty = JSON.stringify(r) !== JSON.stringify(settings.rules);
  return (
    <section>
      <h3>Gubbo rules</h3>
      <p className="muted">Seeded from Gubbo Virality Score v1.0 (11 Nov 2026). {settings.rules.userEdited ? 'You have edited these; your version is kept.' : 'Edit freely — your version always wins.'} Changes apply to new conversations.</p>
      <Row label="Version label"><input value={r.version} onChange={(e) => setR({ ...r, version: e.target.value })} /></Row>
      <label className="stack">Scoring<textarea rows={11} value={r.scoring} onChange={(e) => setR({ ...r, scoring: e.target.value })} /></label>
      <label className="stack">Long-form production constraints<textarea rows={8} value={r.longFormConstraints} onChange={(e) => setR({ ...r, longFormConstraints: e.target.value })} /></label>
      <label className="stack">Shorts<textarea rows={3} value={r.shortsNotes} onChange={(e) => setR({ ...r, shortsNotes: e.target.value })} /></label>
      <button className="primary" disabled={!dirty} onClick={() => patch({ rules: r })}>Save rules</button>
    </section>
  );
}

export function DataSection() {
  const { status, toast } = useApp();
  return (
    <section>
      <h3>Data</h3>
      <p className="muted">Everything is stored on this PC in <code>{status.dataDir}</code> (outside the install folder). Backups contain projects, memory, conversations, settings and your skin — never API keys or the YouTube sign-in.</p>
      <div className="inline wrap">
        <button onClick={async () => { try { const p = await call('backup:export'); if (p) toast(`Backup saved to ${p}`, 'ok'); } catch (e) { toast((e as Error).message, 'error'); } }}>Back up…</button>
        <button onClick={async () => { try { await call('backup:restore'); } catch (e) { toast((e as Error).message, 'error'); } }}>Restore…</button>
        <button onClick={async () => { if (confirm('Erase all conversations? Projects and memory are kept.')) { await call('chat:clear'); toast('Conversations erased.', 'ok'); } }}>Erase conversations</button>
      </div>
      <p className="muted">Version {status.version} · {status.platform} {status.arch}. This personal build is not code-signed, so Windows SmartScreen may show “Windows protected your PC” when the installer is first run; “More info → Run anyway” continues. Nothing in Windows security needs to be turned off.</p>
    </section>
  );
}

/** Small helper for auto-growing textareas used around the panel. */
export function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(200, el.scrollHeight)}px`; } }, [value]);
  return ref;
}
