// Typing into the assistant's browser after Take over (the keyboard button): a field whose additions
// are typed and deletions backspaced as you go, Return sends Enter, and a row of keys for what a
// phone keyboard can't send (Escape, Tab, arrows, Backspace on an empty field).
// M27 W6: `compact` (the landscape full screen) puts the field and the keys in one 44 pt row
// above the system keyboard, so the frame keeps most of what the keyboard leaves.
import SwiftUI

struct ComputerKeyboardBar: View {
    var onInput: (ComputerClientMessage) -> Void
    var compact = false
    var onDone: () -> Void

    @State private var buffer = ""
    /// what the browser already has from this field
    @State private var sent = ""
    @FocusState private var focused: Bool

    var body: some View {
        let layout = compact ? AnyLayout(HStackLayout(spacing: 8)) : AnyLayout(VStackLayout(spacing: 8))
        layout {
            TextField(text: $buffer, prompt: Text("Type in OpenDuet's browser")) { Text("Type in OpenDuet's browser") }
                .font(.system(size: 16))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.return)
                .focused($focused)
                .onSubmit(enter)
                .onChange(of: buffer) { _, new in
                    for message in ComputerTyping.messages(from: sent, to: new) { onInput(message) }
                    sent = new
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .chromeSurface(Capsule(), interactive: true, shadow: false)
                .frame(maxWidth: compact ? 260 : .infinity)
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ComputerKeyButton(systemImage: "escape", label: Text("Escape")) { onInput(.key(.escape)) }
                    ComputerKeyButton(systemImage: "arrow.right.to.line", label: Text("Tab")) { onInput(.key(.tab)) }
                    ComputerKeyButton(systemImage: "arrow.left", label: Text("Left arrow")) { onInput(.key(.arrowLeft)) }
                    ComputerKeyButton(systemImage: "arrow.up", label: Text("Up arrow")) { onInput(.key(.arrowUp)) }
                    ComputerKeyButton(systemImage: "arrow.down", label: Text("Down arrow")) { onInput(.key(.arrowDown)) }
                    ComputerKeyButton(systemImage: "arrow.right", label: Text("Right arrow")) { onInput(.key(.arrowRight)) }
                    ComputerKeyButton(systemImage: "delete.left", label: Text("Delete")) { backspace() }
                    ComputerKeyButton(systemImage: "return", label: Text("Return")) { enter() }
                }
                .padding(.horizontal, 2)
            }
            .scrollIndicators(.hidden)
        }
        .onAppear { focused = true }
    }

    private func enter() {
        onInput(.key(.enter))
        // A new line in the page starts a new field here; nothing is backspaced for the reset.
        sent = ""
        buffer = ""
        Task { @MainActor in focused = true }
    }

    /// Backspace on the page: from the field while it has text, else straight to the browser.
    private func backspace() {
        if buffer.isEmpty {
            onInput(.key(.backspace))
        } else {
            buffer.removeLast()
        }
    }
}

/// A small outlined key of the keyboard bar.
struct ComputerKeyButton: View {
    var systemImage: String
    var label: Text
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Palette.primaryText)
                .frame(minWidth: 44, minHeight: 36)
                .chromeSurface(Capsule(), interactive: true, shadow: false)
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.92))
        .accessibilityLabel(label)
    }
}
