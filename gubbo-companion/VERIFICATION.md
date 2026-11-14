# Verification results

Checked 14 November 2026. Three kinds of evidence, kept apart:

- **Windows CI** — GitHub Actions `windows-latest` (x64), running `.github/workflows/gubbo-companion-windows.yml`
  against the packaged and the installed app. Real Windows, but a server VM without Gavin's hardware or accounts.
- **Automated tests** — `npm test` (49 tests, run on Linux and on Windows CI) plus a click-through of the
  real app against a local **mock** of the Claude API (`scripts/e2e-mock.cjs`, Linux, virtual display).
- **Pending on Gavin's PC** — needs his accounts, skin, microphone or screen. Not tested by anyone yet.

Nothing here was tested against the live Claude API or a live YouTube channel: no API key, credit or
Google sign-in was available while building. Those integrations are implemented and unit-tested against
recorded response shapes, and are **unverified live**.

## Acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| Packaged app launches from its desktop shortcut; no terminal or dev server | **Pass** (Windows CI) | Silent per-user install; `Gubbo Companion.lnk` on the desktop resolves to `%LOCALAPPDATA%\Programs\gubbo-companion\Gubbo Companion.exe`; that exe starts, renders both windows, creates the tray icon. |
| Hotkey registers; collision recovery path | **Pass** for registration (Windows CI); collision handling **unit-level only** | `Control+Alt+G` registered in the installed app. On failure the previous shortcut is kept and alternatives are offered (code path; not exercised against a real conflicting program). |
| Hotkey works from another application | **Pending on Gavin's PC** | Uses the OS-level `globalShortcut`; needs a person pressing keys with another app focused. |
| Imported skin matches the texture incl. outer layers and arm type | **Pass** with test textures (Linux, software 3D); **pending** with Gavin's skin | Rendered classic, slim and legacy 64×32 test skins with distinct colours per face: UV mapping, hat/jacket overlay and 3- vs 4-pixel arms correct; six animation states; 2D fallback when 3D is unavailable. Non-skin images are rejected. |
| Typed conversation uses the selected real model and survives restart | **Pass against mock**; **unverified live** | Request carries `claude-opus-5-5`, adaptive thinking, the chosen effort, no fallback model; reply streams, persists, and is restored after restart. |
| Spoken conversation | **Pass** up to the model call (Windows CI); model reply **unverified live**; audible playback **pending** | In the packaged app: hotkey handler → fake capture device playing a Windows-voice WAV → 16 kHz mono WAV → real whisper.cpp → transcript delivered to the chat path. Windows voices David, Mark and Zira are visible to the app. Sound actually coming out of speakers cannot be observed in CI. |
| Microphone off before activation, stops after sending, never captures the reply | **Pass** by construction and state trace; hardware indicator **pending** | Capture starts only in the toggle handler; tracks are stopped before transcription begins; starting capture cancels speech and speech refuses to start while capturing. State trace: `listening > transcribing > thinking > …`. |
| Budget-exhausted or credit-unverified state blocks before dispatch | **Pass** | Unit tests and UI run: zero requests reach the API when unverified, expired, exhausted, provider-blocked, or without a key. |
| Ambiguous failed requests do not reset cost to zero | **Pass** | Cancelled, dropped and crashed-mid-flight requests stay held at the full reservation until resolved; only explicit API rejections are released. Concurrent reservations cannot overspend. |
| API credentials never in renderer bundles, logs, exports, screenshots | **Pass** | Key absent from the database, backup file and renderer bundles; stored via Windows DPAPI (`secureStorage: true` on Windows CI); the key field is a password input that is cleared after saving; the app writes no logs. |
| Gubbo context source and status accurate; saved decisions retrievable | **Pass** (automated) | Folder index follows outside edits and deletions; imports carry source and time; a rejected idea and its reason are found after restart with "Gavin" provenance. No live two-way sync is claimed. |
| YouTube shows the authorized channel and real responses | **Unverified live** | OAuth (loopback + PKCE, read-only scopes), channel confirmation and report building are implemented; tested with recorded response shapes only. |
| Rounded, delayed, partial, missing and stale data handled correctly | **Pass** (unit) | Subscriber total always described as rounded; windows end at the latest processed day; missing days are flagged, never counted as zero; no percentage from partial periods or a zero base; failed refresh shows cached figures marked stale, or nothing. |
| Launch briefing once per launch; on request again; no AI call | Narration and question detection **pass** (unit); once-per-launch behaviour and spoken output **pending** (needs a connected channel) | Fixed template filled only from fetched values; channel questions are detected locally and never reach Claude; a per-launch flag in the main process prevents repeats. |
| Close/reopen, single instance | **Pass** | Second launch exits and focuses the first; closing the panel keeps the app in the tray. |
| Sleep/resume, microphone loss, monitor changes | **Code paths only — pending on real hardware** | Resume re-checks the shortcut and window position; a lost microphone track cancels the recording with a message; off-screen positions are clamped (unit-tested). |
| Offline mode, token expiry | **Pass** (unit) | Offline: request blocked with a clear message, charge held as uncertain; notes, avatar and cached stats still work. Expired Google sign-in is dropped and a reconnect is requested. |
| No paid voice, hosting, vector DB, search subscription, signing purchase or auto top-up | **Pass** | whisper.cpp + installed Windows voices; SQLite FTS5; unsigned per-user installer; web search is off by default and, when enabled, is Claude's own tool charged to the same credit and counted in the budget. |

## Remaining actions for Gavin

1. Download and run the installer (see README), then follow the wizard.
2. Import the skin PNG.
3. Claim the included API credit, create the workspace key, paste it, and confirm the budget checklist.
   The credit amounts in the original brief ($100 Max / $200 Ultra) were **not** re-verified here; use
   what the Billing page shows.
4. Connect the Gubbo folder or import the Claude project's instructions and files.
5. Download speech recognition, pick a voice, and say something with the shortcut from inside another app.
6. Create the Google API project and connect YouTube; confirm the channel shown is the right one.

If anything in steps 3–6 misbehaves against the live services, that is new information: those paths have
only been exercised against mocks and recorded shapes.

## Known limitations

- Speech recognition runs on the CPU. CUDA builds of whisper.cpp exist but are 270–650 MB and are not used.
- The installer is x64. On Windows on ARM it runs under emulation (the speech download picks the ARM64 binary).
- Unsigned build: SmartScreen warns on first run.
- Chat context is sent in full each turn; very long conversations cost more per reply (the reservation
  shown in the budget reflects this). Start a new conversation to reset.
- Editing the Gubbo rules applies to new conversations, not ones already in progress.
