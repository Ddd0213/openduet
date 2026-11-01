// The gallery's hero card (prompt L147): rounded, tinted by type, a dismiss ✕, the type's big
// outline drawing and an inline composer whose chip ("⊕ Web page" / "▢ Docs" / "▭ Slides") and
// auto-typed idea ("A booking page for my bike shop", "A one-page brief", "A pitch deck for the
// bakery") cycle between the types with a crossfade. Typing stops while the field is in use;
// ↑ with nothing typed makes the idea on show. Reduce Motion: no typing, ideas crossfade.
import SwiftUI

struct HeroCard: View {
    var request: CardRequest?
    var onCreate: (_ type: ArtifactType, _ prompt: String) -> Void
    var onDismiss: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.locale) private var locale
    @State private var index = 0
    @State private var typed = ""
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var type: ArtifactType { ArtifactType.heroOrder[index % ArtifactType.heroOrder.count] }
    private var idea: String { String(localized: type.example) }
    private var paused: Bool { focused || !draft.isEmpty || request != nil }

    var body: some View {
        VStack(spacing: 14) {
            TypeIllustration(type: type, lineWidth: 2)
                .frame(height: 132)
                .id(type)
                .transition(.opacity)
                .padding(.top, 22)
            MakeComposer(
                type: type, text: $draft, placeholder: Text("Describe what to build"),
                typedIdea: typed.isEmpty ? nil : typed, fullIdea: idea,
                request: request, focused: $focused
            ) { prompt in
                onCreate(type, prompt)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: Metrics.heroCorner, style: .continuous)
                .fill(type.heroWash)
                .animation(.easeInOut(duration: 0.6), value: type)
        )
        .overlay(alignment: .topTrailing) {
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Palette.floatingSurface.opacity(0.8)))
                    .contentShape(Circle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.9))
            .padding(10)
            .accessibilityLabel(Text("Hide"))
        }
        .animation(.easeInOut(duration: 0.45), value: index)
        .task(id: paused) { await cycle() }
        .onChange(of: request) { old, new in
            // Made: the field empties for the next idea.
            if old == .inFlight && new == nil { draft = "" }
        }
    }

    /// Types the idea, holds it, then crossfades to the next type; stops while paused.
    private func cycle() async {
        if paused {
            typed = idea
            return
        }
        while !Task.isCancelled {
            let text = idea
            if reduceMotion {
                typed = text
                try? await Task.sleep(for: .seconds(4))
            } else {
                typed = ""
                try? await Task.sleep(for: .milliseconds(400))
                for character in text {
                    guard !Task.isCancelled else { return }
                    typed.append(character)
                    try? await Task.sleep(for: .milliseconds(character == " " ? 70 : 45))
                }
                try? await Task.sleep(for: .seconds(2.4))
            }
            guard !Task.isCancelled else { return }
            index += 1
        }
    }
}
