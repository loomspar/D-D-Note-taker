import SwiftUI
import UIKit

struct SessionDetailView: View {
    let sessionID: UUID

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDelete = false
    @State private var showTranscript = false

    var body: some View {
        if let session = model.store.session(sessionID) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    header(session)

                    if session.stage != .ready {
                        status(session)
                    }
                    if let notes = session.notes, session.stage == .ready {
                        notesBody(notes)
                    }
                    if !session.transcript.isEmpty {
                        transcript(session)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .background { Backdrop() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if session.notes != nil {
                        ShareLink(item: session.shareText) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                    }
                    Menu("More", systemImage: "ellipsis") {
                        if session.notes != nil {
                            Button("Copy notes", systemImage: "doc.on.doc") {
                                UIPasteboard.general.string = session.shareText
                            }
                            Button("Rewrite notes", systemImage: "arrow.clockwise") {
                                model.pipeline.rewriteNotes(sessionID)
                            }
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            confirmDelete = true
                        }
                    }
                    .confirmationDialog("Delete this brainstorm?", isPresented: $confirmDelete, titleVisibility: .visible) {
                        Button("Delete", role: .destructive) {
                            dismiss()
                            model.store.delete(sessionID)
                        }
                    } message: {
                        Text("The notes, transcript and audio will be removed.")
                    }
                }
            }
        } else {
            ContentUnavailableView("Brainstorm not found", systemImage: "questionmark.circle")
        }
    }

    private func header(_ session: BrainstormSession) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(session.displayTitle)
                .font(.largeTitle.weight(.bold))
            Text(session.subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let overview = session.notes?.overview, !overview.isEmpty, session.stage == .ready {
                Text(overview)
                    .padding(.top, 6)
            }
        }
        .padding(.horizontal, 6)
        .padding(.top, 4)
    }

    private func status(_ session: BrainstormSession) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            StageStatus(session: session)
            if session.stage == .failed {
                Button("Try again", systemImage: "arrow.clockwise") {
                    model.pipeline.retry(sessionID)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
            }
        }
        .card()
    }

    @ViewBuilder
    private func notesBody(_ notes: BrainstormNotes) -> some View {
        if !notes.ideas.isEmpty {
            SectionTitle(title: "Ideas", symbol: "lightbulb")
            ForEach(notes.ideas) { idea in
                VStack(alignment: .leading, spacing: 10) {
                    Text(idea.title)
                        .font(.title3.weight(.semibold))
                    if !idea.summary.isEmpty {
                        Text(idea.summary)
                    }
                    ForEach(idea.points, id: \.self) { point in
                        BulletRow(text: point)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .card()
            }
        }
        if !notes.keyPoints.isEmpty {
            SectionTitle(title: "Key points", symbol: "list.bullet")
            VStack(alignment: .leading, spacing: 10) {
                ForEach(notes.keyPoints, id: \.self) { BulletRow(text: $0) }
            }
            .card()
        }
        if !notes.nextSteps.isEmpty {
            SectionTitle(title: "Next steps", symbol: "arrow.right.circle")
            VStack(alignment: .leading, spacing: 10) {
                ForEach(notes.nextSteps, id: \.self) { BulletRow(text: $0) }
            }
            .card()
        }
    }

    private func transcript(_ session: BrainstormSession) -> some View {
        DisclosureGroup(isExpanded: $showTranscript) {
            Text(session.transcript)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 10)
        } label: {
            Label("Full transcript", systemImage: "text.alignleft")
                .font(.headline)
                .foregroundStyle(.primary)
        }
        .card()
        .padding(.top, 8)
    }
}
