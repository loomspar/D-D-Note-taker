# 🎲 Session Scribe

Record your whole D&D session with one microphone in the middle of the table. When you're done, Session Scribe writes detailed, well-organized session notes covering the story recap, key moments, NPCs, places, quests, combat, loot, lore, memorable quotes and what to do next time.

## How it works

1. **Record:** press **Start Recording** in your browser. Audio is saved in 5-minute pieces as you play, so a crash or dead battery won't lose the session.
2. **Transcribe:** each piece is turned into text on your own computer with [Whisper](https://github.com/SYSTRAN/faster-whisper) while the game goes on. The audio never leaves your machine.
3. **Write notes:** when you press **End Session**, the full transcript goes to Claude, which skips the table talk (snack orders, rules arguments, scheduling) and writes up what actually happened in the game.

You can also **upload a recording** you made some other way (phone voice memo, Discord or OBS recording, etc.).

## Setup (one time)

You need:

- **Python 3.10 or newer**: [python.org/downloads](https://www.python.org/downloads/). On Windows, tick "Add Python to PATH" during install.
- **An Anthropic API key**: create one at [console.anthropic.com](https://console.anthropic.com/settings/keys).
- **ffmpeg** (only for uploading existing recordings): `brew install ffmpeg` on Mac, `sudo apt install ffmpeg` on Linux, or `winget install ffmpeg` on Windows.

Then copy `.env.example` to a file named `.env` and paste your key into it:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Running it

- **Mac / Linux:** run `./start.sh`
- **Windows:** double-click `start.bat`

The first run installs everything and downloads the speech-recognition model (about 500 MB), which takes a few minutes. After that, your browser opens to **http://localhost:5000**.

## Tips for good notes

- **Fill in "Campaign info"** on the home page with character names, NPCs and places. It makes a big difference with fantasy names like "Ireena Kolyana".
- **Put the device in the middle of the table** and make sure it's plugged in. A laptop or a cheap USB conference mic works well.
- **Keep the tab open.** You can switch to other tabs or apps, but closing this one stops the recording. The app keeps the screen awake while recording.
- Use **Pause** during breaks.
- If the notes miss something, click **Rewrite** to generate them again. The **Transcript** tab always has the full text.

## Settings (optional)

Set these in `.env`:

| Setting | Default | What it does |
|---|---|---|
| `WHISPER_MODEL` | `small` | Speech model size: `base` is faster, `medium` or `large-v3` is more accurate but slower. |
| `WHISPER_LANGUAGE` | `en` | Language spoken at the table. |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude model used to write the notes. |
| `PORT` | `5000` | Port the app runs on. |

## Cost and speed

- Transcription is free and runs locally. On a typical modern laptop the `small` model keeps up with live speech, so the transcript is nearly finished by the time you end the session.
- Writing notes for a 4-hour session costs roughly **$0.30–$0.60** in Claude API usage and takes a minute or two.

## Where your data lives

Everything (audio, transcripts and notes) is stored in the `data/` folder next to the app. Delete a session in the app, or delete that folder, to remove it.

## Using a phone or tablet as the microphone

Browsers only allow microphone access on `localhost` or HTTPS. The simplest setup is to run the app and record on the same laptop. To record from another device, you'd need to serve the app over HTTPS (for example with a tool like `ngrok` or Tailscale Serve) and start it with `HOST=0.0.0.0`.
