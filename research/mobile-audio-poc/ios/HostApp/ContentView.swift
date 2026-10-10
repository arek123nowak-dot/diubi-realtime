import SwiftUI
import ReplayKit

// Minimal host app UI: a system broadcast picker button (the only legal
// way to let the user start/stop our Broadcast Upload Extension) plus a
// live-polled view of the status log the extension writes to the shared
// App Group container. No ASR/translation here - this is purely to prove
// "can we receive another app's audio at all" before investing further.
struct ContentView: View {
    @State private var statusLines: [String] = []
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 16) {
            Text("DIUBI Audio Capture POC")
                .font(.headline)

            Text("1. Tap the picker below.\n2. Choose \"BroadcastExtension\".\n3. Tap Start Broadcast.\n4. Switch to Spotify/YouTube and play something.\n5. Come back here - lines below update every second.")
                .font(.caption)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            BroadcastPickerView()
                .frame(width: 60, height: 60)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(statusLines.suffix(30), id: \.self) { line in
                        Text(line)
                            .font(.system(size: 11, design: .monospaced))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
            }
        }
        .padding()
        .onReceive(timer) { _ in
            readStatus()
        }
        .onAppear { readStatus() }
    }

    private func readStatus() {
        guard let containerUrl = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            statusLines = ["App Group container not found - check capability setup"]
            return
        }
        let fileUrl = containerUrl.appendingPathComponent("poc_status.log")
        guard let content = try? String(contentsOf: fileUrl, encoding: .utf8) else {
            statusLines = ["Waiting for extension to write poc_status.log ..."]
            return
        }
        statusLines = content.split(separator: "\n").map(String.init)
    }
}

// UIKit RPSystemBroadcastPickerView bridged into SwiftUI. Apple requires
// this exact picker to start a broadcast extension - there is no
// programmatic "just start it" API for third-party apps.
struct BroadcastPickerView: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView()
        // Must match the Broadcast Upload Extension's bundle identifier exactly.
        picker.preferredExtension = "com.diubi.audiopoc.BroadcastExtension"
        picker.showsMicrophoneButton = false
        return picker
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
