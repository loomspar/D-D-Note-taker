import Foundation

enum SummarizerError: LocalizedError {
    case notConfigured
    case badKey
    case busy
    case declined
    case tooLong
    case server(String)
    case unreadable

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            "Your words are saved, but there's nothing set up to write the notes. Add a Claude API key in Settings, or turn on Apple Intelligence."
        case .badKey:
            "Claude didn't accept the API key. Check it in Settings."
        case .busy:
            "Claude is busy right now. Try again in a minute."
        case .declined:
            "Claude declined to write notes for this recording."
        case .tooLong:
            "This brainstorm is too long for on-device notes. Add a Claude API key in Settings to handle long sessions."
        case .server(let message):
            message
        case .unreadable:
            "The notes came back in a form Ramble couldn't read. Try again."
        }
    }
}

/// Picks the notes engine: Claude when an API key is saved, otherwise Apple's on-device model.
enum Summarizer {
    enum Engine { case claude, onDevice, none }

    static var engine: Engine {
        if !Keychain.apiKey.isEmpty { return .claude }
        if OnDeviceSummarizer.isAvailable { return .onDevice }
        return .none
    }

    static func makeNotes(from transcript: String) async throws -> BrainstormNotes {
        let saved = UserDefaults.standard.string(forKey: SettingsKey.focus) ?? ""
        let focus = saved.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? SettingsKey.defaultFocus : saved

        switch engine {
        case .claude:
            return try await ClaudeSummarizer(apiKey: Keychain.apiKey).notes(from: transcript, focus: focus)
        case .onDevice:
            return try await OnDeviceSummarizer.notes(from: transcript, focus: focus)
        case .none:
            throw SummarizerError.notConfigured
        }
    }
}

// MARK: - Claude

struct ClaudeSummarizer {
    let apiKey: String

    static let model = "claude-opus-5-5"

    private static func instructions(focus: String) -> String {
        """
        You turn the transcript of a spoken brainstorm into clean notes for the person who recorded it.

        The speaker was thinking out loud, usually on a long walk. So the transcript rambles: false starts, \
        tangents, ideas that get revised or abandoned, and long stretches of working something out before \
        the point arrives. It was transcribed automatically, so expect wrong words, missing punctuation, and \
        the occasional phrase repeated where two audio segments overlap.

        About the speaker, in their own words: \(focus)

        Capture where the thinking landed, not the journey that got there. When the speaker works through a \
        long chain of thought and finally arrives at a concrete idea, that idea, in its final form, is the \
        thing to record; the reasoning that led to it belongs underneath as supporting points, if at all. \
        If they changed an idea later in the recording, record the latest version. If they dropped an idea, \
        leave it out. Treat moments like "okay, so the idea is", "that's the video", audible excitement, or \
        a thought they keep coming back to as signs that something matters.

        The fields:
        - title: three to six words that name this session so they can find it later.
        - overview: one or two sentences on what the session covered and where it ended up.
        - ideas: every concrete idea they arrived at. For each, title is a short working title they would \
        recognize, summary is one or two sentences stating the idea in its final form, and points are the \
        supporting details they mentioned (angle, hook, structure, examples, why it could work). Order the \
        ideas by how much the speaker seemed to care about them.
        - key_points: important thoughts that aren't part of a specific idea, such as decisions, \
        realizations and open questions.
        - next_steps: things they said they want or need to do. Leave it empty if they named none.
        - highlights: the two or three most important takeaways of the whole session, each under about \
        twelve words and understandable on its own. These appear on a small home-screen widget.

        Record only what the speaker said. Don't add ideas, advice or suggestions of your own. Fix obvious \
        transcription mistakes from context. Write plainly and directly, in the language the speaker used, \
        the way they would jot it down themselves. A short session gets short notes, and empty lists are \
        fine when there is nothing to put in them.
        """
    }

    private static let schema: [String: Any] = {
        let strings: [String: Any] = ["type": "array", "items": ["type": "string"]]
        let idea: [String: Any] = [
            "type": "object",
            "properties": [
                "title": ["type": "string"],
                "summary": ["type": "string"],
                "points": strings,
            ],
            "required": ["title", "summary", "points"],
            "additionalProperties": false,
        ]
        return [
            "type": "object",
            "properties": [
                "title": ["type": "string"],
                "overview": ["type": "string"],
                "ideas": ["type": "array", "items": idea],
                "key_points": strings,
                "next_steps": strings,
                "highlights": strings,
            ],
            "required": ["title", "overview", "ideas", "key_points", "next_steps", "highlights"],
            "additionalProperties": false,
        ]
    }()

    func notes(from transcript: String, focus: String) async throws -> BrainstormNotes {
        let body: [String: Any] = [
            "model": Self.model,
            "max_tokens": 16_000,
            "system": Self.instructions(focus: focus),
            "output_config": [
                "effort": "high",
                "format": ["type": "json_schema", "schema": Self.schema],
            ],
            // If a safety check declines the request, the API retries it on a fallback model.
            "fallbacks": "default",
            "messages": [
                ["role": "user", "content": "Here is the transcript of my brainstorm.\n\n<transcript>\n\(transcript)\n</transcript>"]
            ],
        ]

        var request = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 600
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2026-10-21", forHTTPHeaderField: "anthropic-version")
        request.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let reply = try? JSONDecoder().decode(Reply.self, from: data)

        guard status == 200, let reply else {
            switch status {
            case 401, 403: throw SummarizerError.badKey
            case 429, 500...599: throw SummarizerError.busy
            default:
                let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error.message
                throw SummarizerError.server(message ?? "Claude returned an error (\(status)).")
            }
        }
        if reply.stopReason == "refusal" { throw SummarizerError.declined }

        let json = reply.content.filter { $0.type == "text" }.compactMap(\.text).joined()
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard reply.stopReason != "max_tokens",
              let payload = try? decoder.decode(Payload.self, from: Data(json.utf8))
        else { throw SummarizerError.unreadable }
        return payload.notes
    }

    // The parts of the API reply the app reads.
    private struct Reply: Decodable {
        struct Block: Decodable {
            let type: String
            let text: String?
        }
        let content: [Block]
        let stopReason: String?

        enum CodingKeys: String, CodingKey {
            case content
            case stopReason = "stop_reason"
        }
    }

    private struct Failure: Decodable {
        struct Detail: Decodable { let message: String }
        let error: Detail
    }

    private struct Payload: Decodable {
        struct IdeaPayload: Decodable {
            let title: String
            let summary: String
            let points: [String]
        }
        let title: String
        let overview: String
        let ideas: [IdeaPayload]
        let keyPoints: [String]
        let nextSteps: [String]
        let highlights: [String]

        var notes: BrainstormNotes {
            BrainstormNotes(
                title: title,
                overview: overview,
                highlights: highlights,
                ideas: ideas.map { Idea(title: $0.title, summary: $0.summary, points: $0.points) },
                keyPoints: keyPoints,
                nextSteps: nextSteps
            )
        }
    }
}
