import AVFoundation
import Speech

enum TranscriberError: LocalizedError {
    case unsupportedLanguage

    var errorDescription: String? {
        switch self {
        case .unsupportedLanguage:
            "On-device transcription isn't available for this iPhone's language yet."
        }
    }
}

/// Turns an audio file into text on the iPhone itself. Nothing is uploaded.
enum Transcriber {
    static func transcribe(fileAt url: URL) async throws -> String {
        // A missing or unreadable file (for example one cut short by a crash) is skipped, not fatal.
        guard FileManager.default.fileExists(atPath: url.path),
              let audioFile = try? AVAudioFile(forReading: url),
              audioFile.length > 0
        else { return "" }

        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) else {
            throw TranscriberError.unsupportedLanguage
        }

        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [],
            attributeOptions: []
        )

        // The first run downloads the speech model for this language.
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        async let text = collect(transcriber)

        if let lastSample = try await analyzer.analyzeSequence(from: audioFile) {
            try await analyzer.finalizeAndFinish(through: lastSample)
        } else {
            await analyzer.cancelAndFinishNow()
        }

        return try await text
    }

    private static func collect(_ transcriber: SpeechTranscriber) async throws -> String {
        var text = ""
        for try await result in transcriber.results where result.isFinal {
            text += String(result.text.characters)
        }
        return text
    }
}
