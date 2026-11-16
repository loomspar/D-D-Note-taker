import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [UUID] = []
    @State private var showSettings = false

    var body: some View {
        @Bindable var model = model

        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(spacing: 14) {
                    if model.store.sessions.isEmpty {
                        emptyState
                    } else {
                        ForEach(model.store.sessions) { session in
                            NavigationLink(value: session.id) {
                                SessionCard(session: session)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                if session.notes != nil {
                                    ShareLink(item: session.shareText) {
                                        Label("Share notes", systemImage: "square.and.arrow.up")
                                    }
                                }
                                Button("Delete", systemImage: "trash", role: .destructive) {
                                    model.store.delete(session.id)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background { Backdrop() }
            .navigationTitle("Ramble")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gearshape") { showSettings = true }
                }
            }
            // Functional layer: the one primary action, floating on glass above the list.
            .safeAreaBar(edge: .bottom) {
                Button {
                    Task { await model.startBrainstorm() }
                } label: {
                    Label("Start brainstorm", systemImage: "mic.fill")
                        .font(.title3.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .padding(.bottom, 8)
            }
            .navigationDestination(for: UUID.self) { id in
                SessionDetailView(sessionID: id)
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .fullScreenCover(isPresented: $model.isRecordingPresented) {
                RecordingView()
            }
            .alert(
                "Couldn't start",
                isPresented: Binding(
                    get: { model.alertMessage != nil },
                    set: { if !$0 { model.alertMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.alertMessage ?? "")
            }
            .onChange(of: model.sessionToOpen, initial: true) { _, id in
                guard let id else { return }
                path = [id]
                model.sessionToOpen = nil
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "figure.walk")
                .font(.system(size: 44, weight: .medium))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Think out loud")
                .font(.title2.weight(.semibold))
            Text("Start a brainstorm, lock your phone and go for a walk. When you're done, Ramble hands you the ideas you landed on.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 24)
        .padding(.top, 90)
    }
}

/// One brainstorm in the list.
private struct SessionCard: View {
    let session: BrainstormSession

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(session.displayTitle)
                    .font(.title3.weight(.semibold))
                Text(session.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let notes = session.notes, session.stage == .ready {
                ForEach(notes.highlights.prefix(3), id: \.self) { highlight in
                    BulletRow(text: highlight)
                        .font(.subheadline)
                }
            } else {
                StageStatus(session: session, compact: true)
                    .font(.subheadline)
            }
        }
        .card()
        .contentShape(.rect(cornerRadius: 26, style: .continuous))
    }
}
