# Ramble

An iPhone app for thinking out loud. Tap one button, lock your phone, go for a walk and talk.
When you finish, Ramble gives you short, shareable notes on the ideas you landed on.

## What it does

- **Records for hours.** Recording continues with the phone locked, from the iPhone mic, AirPods or wired headphones. Phone calls pause it and it picks back up afterwards.
- **Transcribes on the iPhone.** Speech is turned into text on-device while you're still walking. Audio never leaves the phone.
- **Finds where your thinking landed.** The notes list the concrete ideas you arrived at (for example, a video idea you talked your way into), then key points and next steps. The full transcript is kept underneath.
- **Shares as plain text.** The share button sends the notes to Messages, Notes, Mail or anywhere else.
- **Shows your top ideas on a widget.** A Home Screen and Lock Screen widget shows the highlights of your latest brainstorm.
- **Starts hands-free.** "Start a brainstorm in Ramble" works with Siri, Shortcuts and the Action Button.

## Putting it on your iPhone

You need a Mac with Xcode 26 or newer and an iPhone on iOS 26 or newer.

1. Open `Ramble.xcodeproj` in Xcode.
2. Click the blue **Ramble** project at the top of the left sidebar. For each of the two targets (**Ramble** and **RambleWidget**), open **Signing & Capabilities** and choose your Apple ID under **Team**.
3. If Xcode says the bundle identifier is taken, change `com.loomspar.ramble` to something of your own in both targets (the widget's must end in `.widget`), and change `group.com.loomspar.ramble` to match in three places: both `.entitlements` files and `Shared/WidgetSnapshot.swift`.
4. Plug in your iPhone, pick it in the device menu at the top of the window, and press the Run button.

With a free Apple ID the app has to be reinstalled from Xcode every 7 days. A paid Apple Developer account ($99/year) removes that limit and allows TestFlight.

## Setting up the notes

Open **Settings** (the gear) in the app.

- **Claude API key** (recommended): paste a key from <https://platform.claude.com/settings/keys>. Ramble sends the transcript to Claude, which writes the notes. A long walk costs roughly 10 to 25 cents. The key is stored in the iPhone Keychain.
- **No key**: on iPhones with Apple Intelligence, notes are written on-device for free. Quality is noticeably rougher on long sessions.
- **About you**: a sentence or two on what you brainstorm about, so the notes know what counts as an idea for you.

## How it's built

SwiftUI with the iOS 26 Liquid Glass design. No third-party dependencies.

| Folder | What's in it |
|---|---|
| `Ramble/App` | App entry point, app state, the Siri/Shortcuts action |
| `Ramble/Services` | Recorder, on-device transcription, notes writers (Claude and on-device), the processing pipeline, storage |
| `Ramble/Views` | Home, recording, notes and settings screens |
| `RambleWidget` | The Home Screen and Lock Screen widget |
| `Shared` | The small data file the app hands to the widget |
| `scripts/generate_project.rb` | Rebuilds `Ramble.xcodeproj` after adding or removing files |
