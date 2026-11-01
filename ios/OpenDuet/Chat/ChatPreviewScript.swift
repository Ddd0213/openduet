// PART A's scripted first chat (prompt L33), for SwiftUI previews only (L3): it drives the real
// MainShellView with fixture ShellStates; the app never shows these texts. DEBUG only.
#if DEBUG
import SwiftUI

struct ChatPreviewScript: View {
    @State private var state = ShellState(userName: "Chris Flores", status: .thinking)
    /// Bumped by the long-press on "CF" to replay the script from the start.
    @State private var run = 0

    private static let statusCycle: [StatusKey] = [.thinking, .checkingMemory, .searchingEmail, .checkingFiles]

    var body: some View {
        var actions = ShellActions()
        actions.restartOnboarding = { run += 1 }
        return MainShellView(state: state, actions: actions)
            .task(id: run) { await play() }
            .task(id: run) { await cycleStatus() }
    }

    private func play() async {
        state.thread = ThreadState(phase: .loaded)
        let steps: [(Double, () -> Void)] = [
            (0.6, { state.thread.typing = true }),
            (1.6, { state.thread.messages = [ChatFixtures.messages[0]] }),
            (3.2, { state.thread.messages.append(ChatFixtures.messages[1]) }),
            (6.0, { state.thread.typing = false }),
        ]
        let clock = ContinuousClock()
        let start = clock.now
        for (time, step) in steps {
            do { try await clock.sleep(until: start.advanced(by: .seconds(time))) } catch { return }
            step()
        }
    }

    /// The pill cycles every 2 s for as long as the preview runs.
    private func cycleStatus() async {
        var index = 0
        while !Task.isCancelled {
            state.status = Self.statusCycle[index % Self.statusCycle.count]
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            index += 1
        }
    }
}

#Preview("Chat – PART A script") {
    ChatPreviewScript()
}

#Preview("Chat – loaded") {
    MainShellView(state: ChatFixtures.loaded, actions: ShellActions())
}

#Preview("Chat – loaded, dark, Chinese") {
    MainShellView(state: ChatFixtures.loaded, actions: ShellActions())
        .preferredColorScheme(.dark)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
}

#Preview("Chat – offline, attachments") {
    MainShellView(state: ChatFixtures.offline, actions: ShellActions())
}

#Preview("Chat – loading / failed / empty") {
    TabView {
        MainShellView(state: ChatFixtures.loading, actions: ShellActions()).tabItem { Text(verbatim: "Loading") }
        MainShellView(state: ChatFixtures.failed, actions: ShellActions()).tabItem { Text(verbatim: "Failed") }
        MainShellView(state: ChatFixtures.empty, actions: ShellActions()).tabItem { Text(verbatim: "Empty") }
    }
}

#Preview("Header – monograms") {
    VStack(spacing: 24) {
        ChatHeader(status: .searchingEmail, userName: "Chris Flores", unreadChannels: 2) {}
        ChatHeader(status: nil, userName: "林晓") {}
        ChatHeader(status: .wakingWorkspace, userName: nil) {}
    }
    .background(Palette.background)
}

#Preview("Markdown") {
    ScrollView {
        AssistantBubble(text: ChatFixtures.summary).padding()
        AssistantBubble(text: "Streaming **bold and [a link](https://exa", streaming: true).padding()
    }
    .background(Palette.background)
}
#endif
