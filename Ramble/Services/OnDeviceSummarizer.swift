import Foundation
#if canImport(FoundationModels)
import FoundationModels

@Generable
struct GeneratedIdea {
    @Guide(description: "A short working title for the idea")
    var title: String
    @Guide(description: "One or two sentences stating the idea in its final form")
    var summary: String
    @Guide(description: "Supporting details the speaker mentioned")
    var points: [String]
}

@Generable
struct GeneratedNotes {
    @Guide(description: "Three to six words naming this brainstorm")
    var title: String
    @Guide(description: "One or two sentences on what was covered and where it ended up")
    var overview: String
    @Guide(description: "The concrete ideas the speaker arrived at, most important first")
    var ideas: [GeneratedIdea]
    @Guide(description: "Important decisions, realizations and open questions that aren't part of an idea")
    var keyPoints: [String]
    @Guide(description: "Things the speaker said they want to do next. Empty if none")
    var nextSteps: [String]
    @Guide(description: "The two or three most important takeaways, each under twelve words")
    var highlights: [String]
}
#endif

/// Writes notes with Apple's on-device model. Free and private, but the model is small:
/// it reads the transcript a piece at a time, so results are rougher than Claude's.
enum OnDeviceSummarizer {
    static var isAvailable: Bool {
        #if canImport(FoundationModels)
        SystemLanguageModel.default.isAvailable
        #else
        false
        #endif
    }

    static func notes(from transcript: String, focus: String) async throws -> BrainstormNotes {
        #if canImport(FoundationModels)
        let about = "About the speaker: \(focus)"

        // 1. Pull the substance out of each piece of the transcript.
        var extracts: [String] = []
        for piece in split(transcript, limit: 5_000) {
            let session = LanguageModelSession(instructions: """
                You are reading one part of a spoken brainstorm, transcribed automatically. \(about)
                List the concrete ideas the speaker arrives at and any important decisions, realizations \
                or to-dos, as short bullet points. Record only what was said. Skip filler and tangents. \
                If this part contains nothing important, reply with "Nothing important."
                """)
            extracts.append(try await session.respond(to: piece).content)
        }

        // 2. Squeeze the bullets down until they fit in a single request.
        var bullets = extracts.joined(separator: "\n")
        var passes = 0
        while bullets.count > 7_000 {
            passes += 1
            guard passes <= 4 else { throw SummarizerError.tooLong }
            var merged: [String] = []
            for piece in split(bullets, limit: 6_000) {
                let session = LanguageModelSession(instructions: """
                    These are bullet-point notes from a brainstorm. Merge duplicates and keep only the most \
                    important ideas, decisions and to-dos. If an idea was revised, keep the latest version. \
                    Reply with a shorter bullet list.
                    """)
                merged.append(try await session.respond(to: piece).content)
            }
            let shorter = merged.joined(separator: "\n")
            guard shorter.count < bullets.count else { throw SummarizerError.tooLong }
            bullets = shorter
        }

        // 3. Turn the bullets into structured notes.
        let session = LanguageModelSession(instructions: """
            You turn bullet points taken from a spoken brainstorm into clean notes. \(about)
            Focus on where the thinking landed: the concrete ideas the speaker arrived at, in their final \
            form. Record only what is in the bullets. Write plainly, the way the speaker would jot it down.
            """)
        let generated = try await session.respond(to: bullets, generating: GeneratedNotes.self).content

        return BrainstormNotes(
            title: generated.title,
            overview: generated.overview,
            highlights: generated.highlights,
            ideas: generated.ideas.map { Idea(title: $0.title, summary: $0.summary, points: $0.points) },
            keyPoints: generated.keyPoints,
            nextSteps: generated.nextSteps
        )
        #else
        throw SummarizerError.notConfigured
        #endif
    }

    /// Splits text into pieces of roughly `limit` characters without cutting words in half.
    private static func split(_ text: String, limit: Int) -> [String] {
        var pieces: [String] = []
        var current = ""
        for word in text.split(whereSeparator: { $0 == " " || $0 == "\n" }) {
            if current.count + word.count + 1 > limit, !current.isEmpty {
                pieces.append(current)
                current = ""
            }
            current += current.isEmpty ? String(word) : " " + word
        }
        if !current.isEmpty { pieces.append(current) }
        return pieces
    }
}
