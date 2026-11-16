import UIKit

/// Takes a brainstorm from audio to notes: transcribe each audio file, then write the notes.
/// Every step is saved as it finishes, so work picks up where it left off after an interruption.
@MainActor
final class Pipeline {
    private let store: SessionStore
    private var running: Set<UUID> = []
    private var needsAnotherPass: Set<UUID> = []
    private var backgroundTasks: [UUID: UIBackgroundTaskIdentifier] = [:]

    init(store: SessionStore) {
        self.store = store
    }

    func isRunning(_ id: UUID) -> Bool { running.contains(id) }

    /// Does whatever work is currently possible for a session. Safe to call at any time.
    func process(_ id: UUID) {
        if running.contains(id) {
            needsAnotherPass.insert(id)
            return
        }
        running.insert(id)
        beginBackgroundTime(for: id)
        Task {
            repeat {
                needsAnotherPass.remove(id)
                await run(id)
            } while needsAnotherPass.contains(id)
            running.remove(id)
            endBackgroundTime(for: id)
        }
    }

    // Buys a little time to finish if the phone gets locked right after you stop.
    private func beginBackgroundTime(for id: UUID) {
        backgroundTasks[id] = UIApplication.shared.beginBackgroundTask(withName: "Ramble notes") { [weak self] in
            Task { @MainActor in self?.endBackgroundTime(for: id) }
        }
    }

    private func endBackgroundTime(for id: UUID) {
        if let task = backgroundTasks.removeValue(forKey: id), task != .invalid {
            UIApplication.shared.endBackgroundTask(task)
        }
    }

    /// Starts over from the saved transcript (or audio) after a failure.
    func retry(_ id: UUID) {
        store.mutate(id) {
            $0.stage = .transcribing
            $0.errorMessage = nil
        }
        process(id)
    }

    /// Writes fresh notes from the transcript that's already saved.
    func rewriteNotes(_ id: UUID) {
        store.mutate(id) {
            $0.stage = .summarizing
            $0.errorMessage = nil
        }
        process(id)
    }

    private func run(_ id: UUID) async {
        // Transcribe every finished audio file that has no text yet. While recording is
        // still going, the file currently being written is left alone.
        while let session = store.session(id),
              let chunk = session.chunks.first(where: {
                  $0.transcript == nil && ($0.isFinished || session.stage != .recording)
              }) {
            do {
                let text = try await Transcriber.transcribe(fileAt: store.audioURL(for: chunk, in: session))
                store.mutate(id) { session in
                    if let index = session.chunks.firstIndex(where: { $0.id == chunk.id }) {
                        session.chunks[index].transcript = text
                    }
                }
            } catch {
                fail(id, error)
                return
            }
        }

        guard let session = store.session(id),
              session.stage == .transcribing || session.stage == .summarizing
        else { return }

        let transcript = session.transcript
        guard !transcript.isEmpty else {
            store.mutate(id) {
                $0.stage = .failed
                $0.errorMessage = "Ramble didn't catch any speech in this recording."
            }
            return
        }

        store.mutate(id) { $0.stage = .summarizing }
        do {
            let notes = try await Summarizer.makeNotes(from: transcript)
            store.mutate(id) {
                $0.notes = notes
                $0.stage = .ready
                $0.errorMessage = nil
            }
            if !UserDefaults.standard.bool(forKey: SettingsKey.keepAudio) {
                store.deleteAudio(for: id)
            }
        } catch {
            fail(id, error)
        }
    }

    private func fail(_ id: UUID, _ error: Error) {
        guard let session = store.session(id) else { return }
        // Mid-recording, a hiccup just means this file is tried again later.
        if session.stage == .recording { return }
        // If iOS paused the app in the background, leave the session as it is;
        // it resumes automatically the next time Ramble opens.
        if UIApplication.shared.applicationState == .background { return }
        store.mutate(id) {
            $0.stage = .failed
            $0.errorMessage = error.localizedDescription
        }
    }
}
