import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { call } from '../bridge';
import { AppProvider, type Tab, useApp } from './app';
import { ChannelScreen } from './channel';
import { Markdown } from './md';
import { MemoryScreen } from './memory';
import { ProjectsScreen } from './projects';
import { BudgetSection, CharacterSection, ClaudeSection, DataSection, GubboSection, RulesSection, ShortcutSection, VoiceSection, useAutosize } from './sections';

const PHASE_LABEL: Record<string, string> = { idle: '', listening: 'Listening… press the shortcut again to send, Esc to cancel', transcribing: 'Transcribing on this PC…', thinking: 'Thinking…', speaking: 'Speaking', celebrating: '', error: '' };

function ChatScreen() {
  const { chat, phase, settings, status, voiceToggle, cancelAll, readAloud, setTab } = useApp();
  const end = useRef<HTMLDivElement>(null);
  const ta = useAutosize(chat.draft);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [chat.messages.length, chat.streaming]);
  const busy = phase === 'thinking' || phase === 'transcribing';
  const model = chat.mode === 'deep' ? settings.ai.deepModel : settings.ai.conversationModel;
  const submit = () => chat.send(chat.draft);
  const starters = ['Give me five long-form ideas that fit my recording budget.', 'What was I working on last time?', 'How is my channel doing?', 'Score this using my Gubbo rules and tell me the weakest part: '];
  return (
    <div className="chat">
      <aside className="convs">
        <button className="primary" onClick={() => chat.open(null)}>+ New conversation</button>
        <ul>{chat.conversations.map((c) => (
          <li key={c.id} className={c.id === chat.conversationId ? 'sel' : ''} onClick={() => chat.open(c.id)} title={new Date(c.updatedAt).toLocaleString()}>
            <span>{c.title}</span>{c.mode === 'deep' && <i className="tag">deep</i>}
            <button className="x" title="Delete conversation" onClick={(e) => { e.stopPropagation(); if (confirm('Delete this conversation?')) chat.remove(c.id); }}>×</button>
          </li>))}</ul>
      </aside>
      <div className="thread">
        <div className="modebar">
          <div className="seg" role="tablist" aria-label="Mode">
            <button className={chat.mode === 'conversation' ? 'on' : ''} disabled={chat.conversationId !== null} onClick={() => chat.setMode('conversation')}>Conversation</button>
            <button className={chat.mode === 'deep' ? 'on' : ''} disabled={chat.conversationId !== null} onClick={() => chat.setMode('deep')}>Deep brainstorm</button>
          </div>
          <span className="muted" title="The model used for this mode. Change it in Settings → Claude.">{model.replace('claude-', '')} · {chat.mode === 'deep' ? settings.ai.deepEffort : settings.ai.conversationEffort} effort{settings.ai.webResearch ? ' · web research on' : ''}</span>
          {status.budget.state === 'ok'
            ? <span className="pill ok" title="Estimated app budget left after the reserve">${(status.budget.remainingUsd ?? 0).toFixed(2)} free</span>
            : <button className="pill warn" onClick={() => setTab('settings')} title={status.budget.message}>Cloud replies off — set up</button>}
        </div>
        <div className="messages">
          {chat.messages.length === 0 && chat.streaming === null && (
            <div className="empty">
              <h2>What are we making?</h2>
              <p className="muted">Press <kbd>{status.hotkey.accelerator.replace('Control', 'Ctrl').replace(/\+/g, ' + ')}</kbd> anywhere to talk, or type below.</p>
              <div className="starters">{starters.map((s) => <button key={s} onClick={() => (s.endsWith(': ') ? chat.setDraft(s) : chat.send(s))}>{s}</button>)}</div>
            </div>
          )}
          {chat.messages.map((m, i) => {
            const mine = m.role === 'user' || (m.role === 'local' && m.meta.kind === 'user');
            return (
              <div key={`${m.id}-${i}`} className={`msg ${mine ? 'user' : 'bot'}`}>
                {mine ? <p>{m.meta.viaVoice && <span className="mic" title="Spoken">🎙 </span>}{m.text}</p> : <Markdown text={m.text} />}
                {!mine && (
                  <div className="meta">
                    {m.role === 'local' ? <span className="tag" title="Built from fetched YouTube figures with a fixed template. No AI call, no cost.">from YouTube data · no AI used</span> : <span className="tag">{m.model?.replace('claude-', '')}</span>}
                    {m.meta.cancelled && <span className="tag warn">stopped early</span>}
                    {m.meta.toolNotes?.map((n, j) => <span key={j} className="tag ok">{n}</span>)}
                    {typeof m.meta.costUsd === 'number' && m.meta.costUsd > 0 && <span className="muted" title="Estimated from the usage the API reported">≈ ${m.meta.costUsd.toFixed(3)}</span>}
                    <button className="link" onClick={() => readAloud(m.text)}>Read aloud</button>
                  </div>
                )}
                {!mine && !!m.meta.sources?.length && (
                  <details className="sources"><summary>{m.meta.sources.length} web results consulted</summary><ul>{m.meta.sources.slice(0, 20).map((s, j) => <li key={j}><a href={s.url} onClick={(e) => { e.preventDefault(); void call('external:open', s.url); }}>{s.title || s.url}</a></li>)}</ul></details>
                )}
              </div>
            );
          })}
          {chat.streaming !== null && (
            <div className="msg bot live">
              {chat.streaming ? <Markdown text={chat.streaming} /> : <p className="muted dots">Thinking</p>}
              {chat.toolNotes.length > 0 && <div className="meta">{chat.toolNotes.map((n, j) => <span key={j} className="tag ok">{n}</span>)}</div>}
            </div>
          )}
          {chat.banner && <div className={`notice ${chat.banner.reason === 'refused' ? 'warn' : 'bad'}`}>{chat.banner.text}{['no_key', 'unverified', 'no_allowance', 'expired', 'exhausted', 'provider_blocked', 'model_unavailable'].includes(chat.banner.reason) && <> <button className="link" onClick={() => setTab('settings')}>Open Settings</button></>}</div>}
          <div ref={end} />
        </div>
        <div className={`composer ${phase}`}>
          {PHASE_LABEL[phase] && <div className="phase">{PHASE_LABEL[phase]}</div>}
          <div className="inline">
            <button className={`mic ${phase === 'listening' ? 'rec' : ''}`} onClick={voiceToggle} disabled={busy} title={phase === 'listening' ? 'Stop and send' : 'Talk'} aria-label={phase === 'listening' ? 'Stop recording and send' : 'Start recording'}>{phase === 'listening' ? '■' : '🎙'}</button>
            <textarea ref={ta} rows={1} value={chat.draft} placeholder="Type to Gubbo…" disabled={phase === 'listening'} onChange={(e) => chat.setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) submit(); } }} />
            {phase === 'idle' || phase === 'error' || phase === 'celebrating'
              ? <button className="primary" disabled={!chat.draft.trim()} onClick={submit}>Send</button>
              : <button className="stop" onClick={cancelAll} title="Esc">Stop</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsScreen() {
  const [sec, setSec] = useState('claude');
  const sections: [string, string, () => React.ReactNode][] = [
    ['claude', 'Claude', () => <><ClaudeSection /><BudgetSection /></>], ['voice', 'Voice', () => <VoiceSection />], ['character', 'Character', () => <CharacterSection />],
    ['shortcut', 'Shortcut', () => <ShortcutSection />], ['gubbo', 'Gubbo project', () => <GubboSection />], ['rules', 'Rules', () => <RulesSection />], ['data', 'Data', () => <DataSection />],
  ];
  return (
    <div className="settings">
      <nav>{sections.map(([id, label]) => <button key={id} className={sec === id ? 'on' : ''} onClick={() => setSec(id)}>{label}</button>)}</nav>
      <div className="scroll">{sections.find(([id]) => id === sec)![2]()}</div>
    </div>
  );
}

function SetupWizard() {
  const { patch, status, settings, setTab } = useApp();
  const [step, setStep] = useState(0);
  const steps: [string, () => React.ReactNode][] = [
    ['Welcome', () => (
      <section>
        <h3>Hi Gavin — let’s set Gubbo up</h3>
        <p>This takes a few minutes. Every step can be skipped and finished later in Settings; Gubbo will tell you plainly what isn’t connected yet rather than pretend.</p>
        <ul className="tight"><li>Your Minecraft skin, as the character</li><li>Your shortcut to summon Gubbo</li><li>Claude (using only your included credit)</li><li>Your existing Gubbo project</li><li>Voice, and your YouTube channel</li></ul>
      </section>)],
    ['Character', () => <CharacterSection />], ['Shortcut', () => <ShortcutSection />], ['Claude', () => <><ClaudeSection /><BudgetSection /></>],
    ['Gubbo project', () => <GubboSection />], ['Voice', () => <VoiceSection />],
    ['YouTube', () => <section><h3>YouTube</h3><p className="muted">Connect your channel (read-only) for spoken briefings. This step is the longest because Google requires you to create your own free API project.</p><ChannelScreen embedded /></section>],
  ];
  const last = step === steps.length - 1;
  const finish = () => { patch({ setupDone: true }); setTab('chat'); };
  return (
    <div className="wizard">
      <ol className="progress">{steps.map(([t], i) => <li key={t} className={i === step ? 'on' : i < step ? 'done' : ''} onClick={() => setStep(i)}>{t}</li>)}</ol>
      <div className="scroll">{steps[step][1]()}</div>
      <footer>
        <span className="muted">{[!status.skin.imported && 'skin', !status.hasApiKey && 'Claude key', status.hasApiKey && status.budget.state !== 'ok' && 'budget', settings.gubbo.mode === 'unset' && 'Gubbo project'].filter(Boolean).join(', ') ? `Still to do: ${[!status.skin.imported && 'skin', !status.hasApiKey && 'Claude key', status.hasApiKey && status.budget.state !== 'ok' && 'budget', settings.gubbo.mode === 'unset' && 'Gubbo project'].filter(Boolean).join(', ')}` : 'Core setup complete'}</span>
        <button onClick={finish}>Finish later</button>
        {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
        {last ? <button className="primary" onClick={finish}>Done</button> : <button className="primary" onClick={() => setStep(step + 1)}>Next</button>}
      </footer>
    </div>
  );
}

function Shell() {
  const { tab, setTab, settings, phase, status } = useApp();
  const tabs: [Tab, string][] = [['chat', 'Talk'], ['projects', 'Videos'], ['channel', 'Channel'], ['memory', 'Memory'], ['settings', 'Settings']];
  if (!settings.setupDone) return <div data-app-ready className="app"><header><h1>Gubbo Companion</h1><span className="muted">Setup</span></header><SetupWizard /></div>;
  return (
    <div data-app-ready className="app">
      <header>
        <h1>Gubbo Companion</h1>
        <nav>{tabs.map(([id, label]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
        <span className={`state ${phase}`}>{phase === 'idle' ? '' : phase}</span>
        {!status.skin.imported && <button className="pill warn" onClick={() => setTab('settings')}>Skin not imported</button>}
      </header>
      {tab === 'chat' && <ChatScreen />}
      {tab === 'projects' && <ProjectsScreen />}
      {tab === 'channel' && <div className="scroll pad"><ChannelScreen /></div>}
      {tab === 'memory' && <MemoryScreen />}
      {tab === 'settings' && <SettingsScreen />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<AppProvider><Shell /></AppProvider>);
