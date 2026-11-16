import AppIntents

/// Lets Siri, Shortcuts and the Action Button start a brainstorm.
struct StartBrainstormIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Brainstorm"
    static var description = IntentDescription("Opens Ramble and starts recording.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await AppModel.shared.startBrainstorm()
        return .result()
    }
}

struct RambleShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartBrainstormIntent(),
            phrases: [
                "Start a brainstorm in \(.applicationName)",
                "Start \(.applicationName)",
            ],
            shortTitle: "Start Brainstorm",
            systemImageName: "mic.fill"
        )
    }
}
