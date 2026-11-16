import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(SettingsKey.focus) private var focus = SettingsKey.defaultFocus
    @AppStorage(SettingsKey.keepAudio) private var keepAudio = false
    @State private var apiKey = Keychain.apiKey

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What do you brainstorm about?", text: $focus, axis: .vertical)
                        .lineLimit(2...6)
                } header: {
                    Text("About you")
                } footer: {
                    Text("A sentence or two helps Ramble recognize what counts as an idea for you.")
                }

                Section {
                    SecureField("Claude API key", text: $apiKey)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .onChange(of: apiKey) { _, newValue in
                            Keychain.apiKey = newValue
                        }
                    LabeledContent("Notes written by", value: engineName)
                    Link("Get an API key", destination: URL(string: "https://platform.claude.com/settings/keys")!)
                } header: {
                    Text("Notes")
                } footer: {
                    Text("With a Claude API key, Ramble sends the transcript (never the audio) to Claude for the best notes. It costs a few cents per brainstorm, billed to your Anthropic account. Without a key, notes are written on this iPhone with Apple Intelligence: free and private, but rougher on long sessions.")
                }

                Section {
                    Toggle("Keep audio after notes are ready", isOn: $keepAudio)
                } footer: {
                    Text("The transcript is always kept. Audio is deleted once the notes are written unless you turn this on. A two-hour walk is about 60 MB.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
    }

    private var engineName: String {
        if !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Claude" }
        return OnDeviceSummarizer.isAvailable ? "Apple Intelligence" : "Not set up"
    }
}
