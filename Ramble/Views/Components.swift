import SwiftUI

// Content layer: cards are solid, softly rounded surfaces. Glass is kept for controls.

extension View {
    /// A rounded content card.
    func card() -> some View {
        self
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 26, style: .continuous))
    }
}

/// The soft tinted wash behind every screen.
struct Backdrop: View {
    var body: some View {
        ZStack {
            Color(.systemGroupedBackground)
            LinearGradient(
                colors: [Color.accentColor.opacity(0.16), Color.accentColor.opacity(0)],
                startPoint: .top,
                endPoint: .center
            )
        }
        .ignoresSafeArea()
    }
}

struct BulletRow: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle()
                .fill(.tint)
                .frame(width: 6, height: 6)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
                .accessibilityHidden(true)
            Text(text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct SectionTitle: View {
    let title: String
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.headline)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.top, 8)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Shows what's happening to a brainstorm that doesn't have notes yet.
struct StageStatus: View {
    let session: BrainstormSession
    var compact = false

    var body: some View {
        switch session.stage {
        case .recording:
            Label("Recording", systemImage: "waveform")
                .foregroundStyle(.secondary)
        case .transcribing:
            VStack(alignment: .leading, spacing: 8) {
                Label("Writing down what you said", systemImage: "text.quote")
                ProgressView(value: session.transcriptionProgress)
            }
            .foregroundStyle(.secondary)
        case .summarizing:
            HStack(spacing: 10) {
                ProgressView()
                Text("Finding your ideas")
            }
            .foregroundStyle(.secondary)
        case .failed:
            Label(session.errorMessage ?? "Something went wrong.", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
                .lineLimit(compact ? 2 : nil)
        case .ready:
            EmptyView()
        }
    }
}
