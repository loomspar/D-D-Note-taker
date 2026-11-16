import Foundation
import Observation

/// The app's single source of truth: saved brainstorms, the recorder, and the notes pipeline.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    let store: SessionStore
    let recorder: Recorder
    @ObservationIgnored let pipeline: Pipeline

    /// The brainstorm currently being recorded.
    private(set) var activeSessionID: UUID?
    var isRecordingPresented = false
    /// Set when a session should be opened (after finishing, or from the widget).
    var sessionToOpen: UUID?
    var alertMessage: String?

    private init() {
        let store = SessionStore()
        self.store = store
        self.recorder = Recorder()
        self.pipeline = Pipeline(store: store)

        recorder.onChunkStarted = { [weak self] fileName in
            guard let self, let id = self.activeSessionID else { return }
            self.store.mutate(id) { $0.chunks.append(AudioChunk(fileName: fileName)) }
        }
        recorder.onChunkFinished = { [weak self] fileName, duration in
            guard let self, let id = self.activeSessionID else { return }
            self.store.mutate(id) { session in
                if let index = session.chunks.firstIndex(where: { $0.fileName == fileName }) {
                    session.chunks[index].duration = duration
                    session.chunks[index].isFinished = true
                }
            }
            // Start turning finished audio into text while the walk continues.
            self.pipeline.process(id)
        }
    }

    func startBrainstorm() async {
        guard recorder.state == .idle else {
            isRecordingPresented = true
            return
        }
        let session = BrainstormSession()
        store.add(session)
        activeSessionID = session.id
        do {
            try await recorder.start(in: store.audioDirectory(for: session.id))
            isRecordingPresented = true
        } catch {
            activeSessionID = nil
            store.delete(session.id)
            alertMessage = error.localizedDescription
        }
    }

    func finishBrainstorm() {
        guard let id = activeSessionID else {
            isRecordingPresented = false
            return
        }
        let duration = recorder.stop()
        activeSessionID = nil
        isRecordingPresented = false

        // An accidental tap isn't a brainstorm.
        guard duration >= 3 else {
            store.delete(id)
            return
        }
        store.mutate(id) {
            $0.duration = duration
            $0.stage = .transcribing
        }
        pipeline.process(id)
        sessionToOpen = id
    }

    func discardBrainstorm() {
        guard let id = activeSessionID else {
            isRecordingPresented = false
            return
        }
        recorder.stop()
        activeSessionID = nil
        isRecordingPresented = false
        store.delete(id)
    }

    /// Picks up anything left unfinished: work paused in the background, or a recording cut short by a crash.
    func resumePending() {
        for session in store.sessions where !pipeline.isRunning(session.id) {
            switch session.stage {
            case .recording where session.id != activeSessionID:
                store.mutate(session.id) {
                    $0.duration = max($0.duration, $0.chunks.reduce(0) { $0 + $1.duration })
                    $0.stage = .transcribing
                }
                pipeline.process(session.id)
            case .transcribing, .summarizing:
                pipeline.process(session.id)
            default:
                break
            }
        }
    }
}
