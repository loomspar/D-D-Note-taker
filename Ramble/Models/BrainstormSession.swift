import Foundation

/// One concrete idea the speaker arrived at.
struct Idea: Codable, Identifiable, Hashable {
    var id = UUID()
    var title: String
    var summary: String
    var points: [String]
}

/// The notes produced from a brainstorm.
struct BrainstormNotes: Codable, Hashable {
    var title: String
    var overview: String
    /// The two or three takeaways shown on the widget.
    var highlights: [String]
    var ideas: [Idea]
    var keyPoints: [String]
    var nextSteps: [String]
}

/// A slice of the recording. Long walks are saved as several short files so a crash
/// never costs more than a few minutes, and so transcription can start while you're still talking.
struct AudioChunk: Codable, Identifiable, Hashable {
    var id = UUID()
    var fileName: String
    var duration: TimeInterval = 0
    var isFinished = false
    var transcript: String?
}

enum SessionStage: String, Codable {
    case recording
    case transcribing
    case summarizing
    case ready
    case failed
}

struct BrainstormSession: Codable, Identifiable, Hashable {
    var id = UUID()
    var startedAt = Date()
    var duration: TimeInterval = 0
    var chunks: [AudioChunk] = []
    var notes: BrainstormNotes?
    var stage: SessionStage = .recording
    var errorMessage: String?

    var transcript: String {
        chunks.compactMap(\.transcript)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    var displayTitle: String { notes?.title ?? "Brainstorm" }

    /// How much of the recording has been turned into text, 0...1.
    var transcriptionProgress: Double {
        guard !chunks.isEmpty else { return 0 }
        return Double(chunks.filter { $0.transcript != nil }.count) / Double(chunks.count)
    }

    var subtitle: String {
        let date = startedAt.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
        return duration >= 1 ? "\(date) · \(Format.friendly(duration))" : date
    }

    /// Plain text for Messages, Notes, Mail and anywhere else the share sheet goes.
    var shareText: String {
        guard let notes else { return transcript }
        var lines: [String] = [notes.title, subtitle, ""]
        if !notes.overview.isEmpty { lines += [notes.overview, ""] }
        if !notes.ideas.isEmpty {
            lines.append("IDEAS")
            for (index, idea) in notes.ideas.enumerated() {
                lines.append("\(index + 1). \(idea.title)")
                if !idea.summary.isEmpty { lines.append("   \(idea.summary)") }
                lines += idea.points.map { "   • \($0)" }
                lines.append("")
            }
        }
        if !notes.keyPoints.isEmpty {
            lines.append("KEY POINTS")
            lines += notes.keyPoints.map { "• \($0)" }
            lines.append("")
        }
        if !notes.nextSteps.isEmpty {
            lines.append("NEXT STEPS")
            lines += notes.nextSteps.map { "• \($0)" }
            lines.append("")
        }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum Format {
    /// 1:02:03 or 12:05, for the live timer.
    static func clock(_ time: TimeInterval) -> String {
        let total = Int(time.rounded(.down))
        let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// "47 min" or "1 hr 12 min".
    static func friendly(_ time: TimeInterval) -> String {
        let minutes = Int((time / 60).rounded())
        if minutes < 1 { return "under a minute" }
        if minutes < 60 { return "\(minutes) min" }
        let rest = minutes % 60
        return rest == 0 ? "\(minutes / 60) hr" : "\(minutes / 60) hr \(rest) min"
    }
}

enum SettingsKey {
    static let focus = "focus"
    static let keepAudio = "keepAudio"
    static let defaultFocus = "I make YouTube videos. Most of my brainstorming is about ideas for new videos for my channels."
}
