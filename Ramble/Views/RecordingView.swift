import SwiftUI

struct RecordingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirmDiscard = false

    var body: some View {
        let recorder = model.recorder
        let isPaused = recorder.state == .paused

        VStack(spacing: 0) {
            Spacer()

            // Content layer: a soft orb that breathes with your voice, and the running time.
            ZStack {
                TimelineView(.animation(minimumInterval: 1.0 / 20, paused: isPaused || reduceMotion)) { _ in
                    VoiceOrb(level: reduceMotion ? 0.3 : recorder.level(), isPaused: isPaused)
                }
                TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                    Text(Format.clock(recorder.elapsed))
                        .font(.system(size: 64, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .accessibilityLabel("Recorded \(Format.friendly(recorder.elapsed))")
                }
            }
            .frame(height: 320)

            Text(isPaused ? "Paused" : "Listening")
                .font(.title3.weight(.medium))
                .padding(.top, 8)
            Text("Lock your phone and keep walking. Ramble keeps listening until you finish.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
                .padding(.top, 6)

            Spacer()

            // Functional layer: the three controls share one glass container.
            GlassEffectContainer(spacing: 18) {
                HStack(spacing: 18) {
                    Button {
                        confirmDiscard = true
                    } label: {
                        Image(systemName: "trash")
                            .font(.title3)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("Discard")
                    .confirmationDialog("Discard this brainstorm?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                        Button("Discard", role: .destructive) { model.discardBrainstorm() }
                        Button("Keep recording", role: .cancel) {}
                    } message: {
                        Text("The recording will be deleted.")
                    }

                    Button {
                        model.finishBrainstorm()
                    } label: {
                        Label("Finish", systemImage: "stop.fill")
                            .font(.title3.weight(.semibold))
                            .padding(.horizontal, 18)
                            .frame(height: 44)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.capsule)

                    Button {
                        if isPaused { recorder.resume() } else { recorder.pause() }
                    } label: {
                        Image(systemName: isPaused ? "play.fill" : "pause.fill")
                            .font(.title3)
                            .frame(width: 44, height: 44)
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel(isPaused ? "Resume" : "Pause")
                }
            }
            .padding(.bottom, 28)
        }
        .frame(maxWidth: .infinity)
        .background { Backdrop() }
        .interactiveDismissDisabled()
    }
}

private struct VoiceOrb: View {
    let level: Double
    let isPaused: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.accentColor.opacity(0.18))
                .frame(width: 250, height: 250)
                .scaleEffect(1 + level * 0.28)
                .blur(radius: 26)
            Circle()
                .fill(Color.accentColor.opacity(0.22))
                .frame(width: 200, height: 200)
                .scaleEffect(1 + level * 0.14)
                .blur(radius: 10)
        }
        .opacity(isPaused ? 0.45 : 1)
        .animation(.smooth(duration: 0.18), value: level)
        .animation(.smooth, value: isPaused)
        .accessibilityHidden(true)
    }
}
