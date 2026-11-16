import Foundation
import Observation
import WidgetKit

/// Keeps every brainstorm on disk: one small JSON file per session plus a folder of audio.
@MainActor
@Observable
final class SessionStore {
    private(set) var sessions: [BrainstormSession] = []

    @ObservationIgnored private let sessionsDirectory: URL
    @ObservationIgnored private let audioRoot: URL
    @ObservationIgnored private let encoder = JSONEncoder()

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        sessionsDirectory = documents.appendingPathComponent("Sessions", isDirectory: true)
        audioRoot = documents.appendingPathComponent("Audio", isDirectory: true)
        try? FileManager.default.createDirectory(at: sessionsDirectory, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: audioRoot, withIntermediateDirectories: true)
        encoder.dateEncodingStrategy = .iso8601
        load()
    }

    func session(_ id: UUID) -> BrainstormSession? {
        sessions.first { $0.id == id }
    }

    func add(_ session: BrainstormSession) {
        sessions.insert(session, at: 0)
        save(session)
    }

    /// Changes one session and writes it to disk.
    func mutate(_ id: UUID, _ change: (inout BrainstormSession) -> Void) {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        change(&sessions[index])
        save(sessions[index])
    }

    func delete(_ id: UUID) {
        sessions.removeAll { $0.id == id }
        try? FileManager.default.removeItem(at: fileURL(for: id))
        deleteAudio(for: id)
        refreshWidget()
    }

    func audioDirectory(for id: UUID) -> URL {
        let url = audioRoot.appendingPathComponent(id.uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func audioURL(for chunk: AudioChunk, in session: BrainstormSession) -> URL {
        audioRoot.appendingPathComponent(session.id.uuidString, isDirectory: true)
            .appendingPathComponent(chunk.fileName)
    }

    func deleteAudio(for id: UUID) {
        try? FileManager.default.removeItem(at: audioRoot.appendingPathComponent(id.uuidString, isDirectory: true))
    }

    // MARK: - Disk

    private func fileURL(for id: UUID) -> URL {
        sessionsDirectory.appendingPathComponent("\(id.uuidString).json")
    }

    private func load() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let files = (try? FileManager.default.contentsOfDirectory(at: sessionsDirectory, includingPropertiesForKeys: nil)) ?? []
        sessions = files
            .filter { $0.pathExtension == "json" }
            .compactMap { try? decoder.decode(BrainstormSession.self, from: Data(contentsOf: $0)) }
            .sorted { $0.startedAt > $1.startedAt }
    }

    private func save(_ session: BrainstormSession) {
        if let data = try? encoder.encode(session) {
            try? data.write(to: fileURL(for: session.id), options: .atomic)
        }
        refreshWidget()
    }

    /// The widget always shows the newest brainstorm that has notes.
    private func refreshWidget() {
        let latest = sessions.first { $0.notes != nil }
        let snapshot = latest.flatMap { session -> WidgetSnapshot? in
            guard let notes = session.notes else { return nil }
            let highlights = notes.highlights.isEmpty ? notes.ideas.map(\.title) : notes.highlights
            return WidgetSnapshot(title: notes.title, date: session.startedAt, highlights: Array(highlights.prefix(4)))
        }
        if WidgetSnapshot.store(snapshot) {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}
