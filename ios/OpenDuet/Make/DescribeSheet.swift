// The Describe sheet (prompt L149): full screen, the mascot top-centre, ✕ top-right, the type's
// large outline drawing with its caption ("A dashboard"), and the composer: the type chip,
// "Describe what to build", the mic (dictation) and ↑, orange once there is text. It stays
// until Create is answered (the Build view then opens), so a failure shows here with its
// reason. It follows the finger down to close. M20: without the assistant's computer on the server, a
// line above the composer says builds need it (MakeComputerHint).
import SwiftUI

struct DescribeSheet: View {
    var type: ArtifactType
    var request: CardRequest?
    var onCreate: (_ prompt: String) -> Void
    var onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft = ""
    @State private var drag: CGFloat = 0
    @FocusState private var focused: Bool
    @ScaledMetric(relativeTo: .title) private var captionSize: CGFloat = 26

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(spacing: 18) {
                    TypeIllustration(type: type, lineWidth: 2.5)
                        .frame(maxWidth: 300)
                        .padding(.horizontal, 40)
                        .padding(.top, 28)
                    Text(type.caption)
                        .font(Typography.serifTitle(captionSize))
                        .foregroundStyle(Palette.primaryText)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .accessibilityAddTraits(.isHeader)
                }
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            // M20: on a server without the assistant's computer, one line says builds need it, with Set up
            // opening its detail (the deploy command); nothing otherwise.
            MakeComputerHint(onClose: onClose)
            MakeComposer(
                type: type, text: $draft, placeholder: Text("Describe what to build"),
                allowsDictation: true, request: request, focused: $focused, onSend: onCreate
            )
            .padding(.horizontal, Metrics.threadInset)
            .padding(.bottom, 12)
        }
        .background(Palette.background.ignoresSafeArea())
        .offset(y: drag)
        .task {
            try? await Task.sleep(for: .milliseconds(350))
            focused = true
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            Color.clear.frame(width: Metrics.headerCircle, height: Metrics.headerCircle)
            Spacer(minLength: 12)
            DuetMascot(pose: .idle, size: 34, animated: true)
                .floatingCircle(Metrics.headerMascot, interactive: false)
                .accessibilityHidden(true)
            Spacer(minLength: 12)
            CircleIconButton(systemImage: DuetGlyph.close.symbol, label: Text("Close"), action: onClose)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 10)
                .onChanged { value in drag = reduceMotion ? 0 : max(value.translation.height, 0) }
                .onEnded { value in
                    if value.translation.height > 120 || value.predictedEndTranslation.height > 260 {
                        onClose()
                    } else {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { drag = 0 }
                    }
                }
        )
    }
}
