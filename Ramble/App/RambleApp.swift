import SwiftUI

@main
struct RambleApp: App {
    @State private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environment(model)
                .onOpenURL { url in
                    // The widget opens ramble://latest.
                    if url.host == "latest", let latest = model.store.sessions.first(where: { $0.notes != nil }) {
                        model.sessionToOpen = latest.id
                    }
                }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            if phase == .active { model.resumePending() }
        }
    }
}
