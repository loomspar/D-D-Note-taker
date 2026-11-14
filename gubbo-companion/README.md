# Gubbo Companion

A Windows desktop app for Gavin: a video brainstorming partner and workflow assistant that appears as
his own Minecraft character. Summon it with a keyboard shortcut, talk or type, and it remembers video
projects, scores ideas with the Gubbo rules, and gives a spoken briefing on the YouTube channel.

Everything runs on the PC except two things: replies from Claude (through the Claude API, paid from the
API credit included with the Claude subscription) and read-only YouTube statistics from Google.

## Install

1. Download `Gubbo-Companion-Setup-<version>.exe`. Each push to the working branch builds it on a Windows
   machine in GitHub Actions: open the repository's **Actions** tab → latest **Gubbo Companion (Windows
   build)** run → **Artifacts** → `Gubbo-Companion-Setup`.
2. Run it. It installs for the current user only (no administrator prompt) into
   `%LOCALAPPDATA%\Programs\gubbo-companion` and adds **Gubbo Companion** shortcuts to the desktop and Start menu.
3. This personal build is not code-signed, so SmartScreen may show "Windows protected your PC" the first
   time. Choose **More info → Run anyway**. Do not turn off any Windows security feature for it.

Data is kept in `%APPDATA%\Gubbo Companion`, outside the install folder, and survives updates and uninstalls.

## First-run setup (about 15 minutes; every step can be skipped and finished later)

The app opens a setup wizard. What it needs from Gavin:

| Step | What to do | Needed for |
|---|---|---|
| Character | Nothing: the Gubbo skin (the one on the Minecraft account **GubboYT**, matching the channel picture) is built in. To change it, type a Minecraft username or import a skin PNG. | The character. |
| Shortcut | Default is **Ctrl + Alt + G**. If another program owns it the app says so and offers alternatives. | Summoning by keyboard. |
| Claude | In Claude **Settings → Billing**, claim the included API credit by linking a Console organization. In the Claude Console create a workspace and an API key for this app and paste the key into the app's key box (never into a chat). | Replies. |
| Budget | In Console → Billing confirm auto-reload is **off** and there are no purchased credits, then type in the credit amount and expiry date the Console shows. | Cloud requests stay off until this is confirmed. |
| Gubbo project | Choose **Use a local folder** if Gubbo is a folder on the PC, or **Import** files / pasted text if it is a Project inside Claude. | Starting with existing rules and history. |
| Voice | **Download speech recognition** (one time: about 9 MB program + 78–488 MB model, checksum-verified). Pick and preview an installed Windows voice. | Talking instead of typing. |
| YouTube | Create a free Google Cloud project, enable *YouTube Data API v3* and *YouTube Analytics API*, create a **Desktop app** OAuth client, paste its ID and secret, press **Connect YouTube**, confirm the channel. The wizard links to each page. | Channel briefings. |

Things worth knowing:

- **No extra spending.** The app never adds a payment method, buys credit or uses another paid service.
  Before every request it reserves the most that request could cost; if that does not fit the remaining
  budget (minus a reserve) the request is not sent. Cancelled or dropped requests stay *held* at their
  full reserved amount until resolved in Settings → Budget. The figures are the app's own estimates —
  an API key cannot read the organization's balance — so re-enter the Console figure when you check it.
- **Claude Projects are not synced.** There is no supported way for an app to read a claude.ai Project,
  and an API key gives no access to chats or Projects. Import is one-way, labelled with source and time;
  **Refresh imported context** re-reads the files and **Export for Gubbo** writes one Markdown file to
  add back to the project.
- **The shortcut only works while the app is running** (it lives in the tray). Turn on *Start with
  Windows* in Settings → Shortcut to have it always available.
- **Google "Testing" mode** signs the app out every 7 days. Press *Publish app* on the Google Auth
  Platform → Audience page to avoid that (no verification is needed for personal read-only use).
- **Not available through the YouTube API reports used:** impressions, click-through rate and retention
  curves. They are left out rather than estimated.

## Using it

By default the app runs in **Just Gubbo** mode: the only thing on screen is the character in the corner.
Press the shortcut, talk, press it again — he answers out loud, with captions beside him. Long or
structured answers (scripts, checklists, scored shortlists) are saved to the video and he tells you the
gist. Click him to open the full panel; turn the mode off in Settings → Shortcut.

- **Ctrl + Alt + G** once: Gubbo appears, stops talking and listens. Again: transcribe and send.
  **Esc**: cancel listening, thinking or speaking (Esc is only captured while one of those is active).
- **Talk** tab: Conversation (Claude Opus 5.5) or Deep brainstorm (Claude Fable 5.2, high effort). The
  model in use is always shown; the app never switches models by itself.
- "How is my channel doing?", "How many subscribers do I have?" and "Give me my channel briefing" are
  answered from fetched YouTube figures with a fixed template — no AI call and no cost.
- **Videos** tab: cards moving through Idea → Developing → Ready to record → Recorded → Editing →
  Published → Reviewed, each with documents (versioned), scores, decisions, sources; brain dumps with a
  preview before anything is filed; **History** to undo.
- **Memory** tab: everything Gubbo remembers, marked as "you said this" or "Gubbo's suggestion";
  edit or delete any of it.
- Tray icon: Open, Talk, Channel briefing, Settings, Quit. Closing the window keeps it in the tray.

## Build from source (on Windows)

Requires Node.js 22 or newer.

```powershell
cd gubbo-companion
npm ci
npm test            # unit tests
npm run dist        # builds and packages release\Gubbo-Companion-Setup-<version>.exe
node scripts/smoke.mjs "release\win-unpacked\Gubbo Companion.exe"                 # packaged-app smoke test
node scripts/verify-voice.mjs "release\win-unpacked\Gubbo Companion.exe"          # Windows voice → whisper.cpp → app
```

`npm start` runs it unpackaged. The installer can also be cross-built on Linux (needs Wine with 32-bit
support for the NSIS step). There are no native modules: storage uses the SQLite built into Electron's
Node, secrets use Windows DPAPI through Electron `safeStorage`, speech uses installed Windows voices.

## How it is put together

| Part | Where |
|---|---|
| Main process: windows, tray, hotkey, IPC | `src/main/main.ts` |
| Budget ledger and reservations | `src/main/budget.ts`, `src/main/pricing.ts` |
| Claude conversation loop, tools, prompts | `src/main/ai.ts`, `src/main/tools.ts`, `src/main/prompt.ts` |
| Videos, documents, memory, search (SQLite FTS5) | `src/main/store.ts`, `src/main/db.ts` |
| Gubbo folder / import / export | `src/main/context.ts` |
| YouTube OAuth, API client, interpretation, narration | `src/main/youtube/` |
| whisper.cpp download and transcription | `src/main/voice/whisper.ts` |
| Narrow preload bridge | `src/preload/preload.ts` |
| Character window (skinview3d) and panel (React) | `src/renderer/` |

Security posture: renderer sandboxed with context isolation and no Node integration; a strict content
security policy; an allow-listed IPC bridge with every payload validated again in the main process; the
model can only call twelve narrow tools (create/version/read — no delete, no shell, no file paths); API
keys and Google tokens are encrypted by Windows and readable only by the main process, in a file that is
never part of backups or exports.

## Verification

See [VERIFICATION.md](VERIFICATION.md) for what was tested, how, and what is still pending on Gavin's PC.
