import AVFoundation
import Observation

enum RecorderError: LocalizedError {
    case microphoneDenied
    case couldNotStart

    var errorDescription: String? {
        switch self {
        case .microphoneDenied:
            "Ramble needs the microphone. Turn it on in Settings › Privacy & Security › Microphone."
        case .couldNotStart:
            "Recording couldn't start. Check that no other app is using the microphone and try again."
        }
    }
}

/// Records for as long as you like, with the phone locked, from whichever microphone is
/// active (iPhone, AirPods, wired headphones). Audio is written as a series of five-minute files.
@MainActor
@Observable
final class Recorder {
    enum State { case idle, recording, paused }

    private(set) var state: State = .idle

    /// Called with the file name when a new audio file starts.
    @ObservationIgnored var onChunkStarted: ((String) -> Void)?
    /// Called with the file name and length when an audio file is complete.
    @ObservationIgnored var onChunkFinished: ((String, TimeInterval) -> Void)?

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var currentFileName: String?
    @ObservationIgnored private var directory: URL?
    @ObservationIgnored private var chunkIndex = 0
    @ObservationIgnored private var finishedDuration: TimeInterval = 0
    @ObservationIgnored private var rotationTask: Task<Void, Never>?
    @ObservationIgnored private var interruptionObserver: NSObjectProtocol?

    private static let chunkLength: TimeInterval = 300

    /// Total time recorded so far. Poll it; it isn't observed.
    var elapsed: TimeInterval {
        finishedDuration + (recorder?.currentTime ?? 0)
    }

    /// Current loudness, 0...1, for the on-screen visual.
    func level() -> Double {
        guard state == .recording, let recorder else { return 0 }
        recorder.updateMeters()
        let decibels = Double(recorder.averagePower(forChannel: 0))
        return min(1, max(0, (decibels + 50) / 50))
    }

    func start(in directory: URL) async throws {
        guard state == .idle else { return }
        guard await AVAudioApplication.requestRecordPermission() else {
            throw RecorderError.microphoneDenied
        }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
        try session.setActive(true)

        self.directory = directory
        chunkIndex = 0
        finishedDuration = 0

        let (newRecorder, name) = try makeRecorder()
        recorder = newRecorder
        currentFileName = name
        state = .recording
        onChunkStarted?(name)

        observeInterruptions()
        startRotationLoop()
    }

    func pause() {
        guard state == .recording else { return }
        recorder?.pause()
        state = .paused
    }

    func resume() {
        guard state == .paused else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        if recorder?.record() == true {
            state = .recording
        } else {
            // The old file can't continue (for example after a phone call); carry on in a new one.
            state = .recording
            if !rotate() { state = .paused }
        }
    }

    /// Stops recording and returns the total length.
    @discardableResult
    func stop() -> TimeInterval {
        rotationTask?.cancel()
        rotationTask = nil
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
        interruptionObserver = nil

        if let recorder, let name = currentFileName {
            let duration = recorder.currentTime
            recorder.stop()
            finishedDuration += duration
            onChunkFinished?(name, duration)
        }
        recorder = nil
        currentFileName = nil
        state = .idle
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return finishedDuration
    }

    // MARK: - Files

    private func makeRecorder() throws -> (AVAudioRecorder, String) {
        guard let directory else { throw RecorderError.couldNotStart }
        let name = String(format: "part-%04d.m4a", chunkIndex)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 22_050,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        let newRecorder = try AVAudioRecorder(url: directory.appendingPathComponent(name), settings: settings)
        newRecorder.isMeteringEnabled = true
        guard newRecorder.record() else { throw RecorderError.couldNotStart }
        chunkIndex += 1
        return (newRecorder, name)
    }

    /// Starts the next file before closing the current one, so no words fall in the gap.
    /// If the next file can't start, the current one simply keeps going.
    @discardableResult
    private func rotate() -> Bool {
        guard state == .recording, let old = recorder, let oldName = currentFileName else { return false }
        guard let (next, nextName) = try? makeRecorder() else { return false }
        let duration = old.currentTime
        old.stop()
        finishedDuration += duration
        recorder = next
        currentFileName = nextName
        onChunkStarted?(nextName)
        onChunkFinished?(oldName, duration)
        return true
    }

    private func startRotationLoop() {
        rotationTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled else { return }
                if self.state == .recording, (self.recorder?.currentTime ?? 0) >= Self.chunkLength {
                    self.rotate()
                }
            }
        }
    }

    // MARK: - Interruptions (phone calls, Siri, alarms)

    private func observeInterruptions() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let type = raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            Task { @MainActor in
                guard let self, let type else { return }
                switch type {
                case .began:
                    if self.state == .recording { self.interrupted = true; self.pause() }
                case .ended:
                    if self.interrupted { self.interrupted = false; self.resume() }
                @unknown default:
                    break
                }
            }
        }
    }

    @ObservationIgnored private var interrupted = false
}
