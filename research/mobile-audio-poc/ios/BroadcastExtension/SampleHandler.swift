import ReplayKit
import os.log
import AVFoundation

// Minimal proof-of-concept Broadcast Upload Extension.
// Goal: confirm we receive non-silent PCM audio buffers that originate
// from OTHER apps (e.g. Spotify/YouTube) while the user is not inside
// our own app. Does NOT run ASR or translation here - this process has
// a tight memory limit and cannot play audio back, so it only logs and
// optionally mirrors a short rolling window to a shared App Group file
// for manual inspection.
//
// IMPORTANT: replace "group.com.diubi.audiopoc" below with your own App
// Group identifier (must be enabled on BOTH this extension target and
// the host app target, with the exact same string).
let appGroupId = "group.com.diubi.audiopoc"
let log = OSLog(subsystem: "com.diubi.audiopoc", category: "BroadcastExtension")

class SampleHandler: RPBroadcastSampleHandler {

    private var appAudioBufferCount = 0
    private var micAudioBufferCount = 0
    private var videoBufferCount = 0
    private var lastStatusWriteAt = Date()

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        os_log("DIUBI_POC broadcastStarted", log: log, type: .info)
        appAudioBufferCount = 0
        micAudioBufferCount = 0
        videoBufferCount = 0
        writeStatus("started")
    }

    override func broadcastPaused() {
        os_log("DIUBI_POC broadcastPaused", log: log, type: .info)
    }

    override func broadcastResumed() {
        os_log("DIUBI_POC broadcastResumed", log: log, type: .info)
    }

    override func broadcastFinished() {
        os_log("DIUBI_POC broadcastFinished appAudio=%d mic=%d video=%d",
               log: log, type: .info, appAudioBufferCount, micAudioBufferCount, videoBufferCount)
        writeStatus("finished appAudio=\(appAudioBufferCount) mic=\(micAudioBufferCount) video=\(videoBufferCount)")
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .audioApp:
            appAudioBufferCount += 1
            let rms = rmsAmplitude(of: sampleBuffer)
            os_log("DIUBI_POC audioApp buffer #%d rms=%.4f", log: log, type: .debug, appAudioBufferCount, rms)
            maybeWriteStatusThrottled(tag: "audioApp", rms: rms)
        case .audioMic:
            micAudioBufferCount += 1
            // Logged but not the focus of this POC - we care about audioApp
            // (other apps' playback), not the microphone.
        case .video:
            videoBufferCount += 1
        @unknown default:
            break
        }
    }

    // Root-mean-square amplitude of the PCM samples in this buffer - a
    // cheap, dependency-free way to confirm "is this silence or real
    // audio content" without needing to decode/play anything.
    private func rmsAmplitude(of sampleBuffer: CMSampleBuffer) -> Double {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return 0 }
        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer) == kCMBlockBufferNoErr,
              let pointer = dataPointer, length > 0 else { return 0 }

        let sampleCount = length / MemoryLayout<Int16>.size
        guard sampleCount > 0 else { return 0 }
        let samples = pointer.withMemoryRebound(to: Int16.self, capacity: sampleCount) { $0 }
        var sumSquares: Double = 0
        for i in 0..<sampleCount {
            let normalized = Double(samples[i]) / Double(Int16.max)
            sumSquares += normalized * normalized
        }
        return (sumSquares / Double(sampleCount)).squareRoot()
    }

    // Writes a short status line to a file in the shared App Group
    // container so the host app (or Files app) can show the latest
    // confirmation without needing a cable + Console.app. Throttled to
    // avoid hammering disk I/O inside the memory/CPU-constrained extension.
    private func maybeWriteStatusThrottled(tag: String, rms: Double) {
        let now = Date()
        guard now.timeIntervalSince(lastStatusWriteAt) > 1.0 else { return }
        lastStatusWriteAt = now
        writeStatus(String(format: "%@ rms=%.4f buffers(app=%d mic=%d video=%d)", tag, rms, appAudioBufferCount, micAudioBufferCount, videoBufferCount))
    }

    private func writeStatus(_ line: String) {
        guard let containerUrl = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            os_log("DIUBI_POC ERROR: App Group container not found - check the App Group capability on both targets", log: log, type: .error)
            return
        }
        let fileUrl = containerUrl.appendingPathComponent("poc_status.log")
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let entry = "[\(timestamp)] \(line)\n"
        if let data = entry.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: fileUrl.path) {
                if let handle = try? FileHandle(forWritingTo: fileUrl) {
                    handle.seekToEndOfFile()
                    handle.write(data)
                    handle.closeFile()
                }
            } else {
                try? data.write(to: fileUrl)
            }
        }
    }
}
