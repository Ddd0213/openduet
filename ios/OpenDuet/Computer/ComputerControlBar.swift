// The bottom of "OpenDuet's computer": the human-check note when a site wants one (L144), the
// reason when Take over / Hand back (or M20's "Let it sleep") failed, and the black full-width
// capsule ("Take over" / "Hand back to OpenDuet", a spinner inside while that request runs; dimmed
// while "Let it sleep" runs, which has its own spinner, and while the browser is asleep).
// M27 W6: ComputerControlColumn is the same in the landscape full screen's right margin.
import SwiftUI

struct ComputerControlBar: View {
    var view: ComputerViewState
    /// M20: the full-screen view shows the browser asleep after "Let it sleep"
    var resting = false
    var onTake: () -> Void
    var onRelease: () -> Void

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17
    @ScaledMetric(relativeTo: .footnote) private var noteSize: CGFloat = 14

    private var enabled: Bool { ComputerDeployRules.canToggleControl(view, resting: resting) }
    private var toggling: Bool { ComputerDeployRules.isToggling(view) }

    var body: some View {
        let inControl = view.isUserInControl
        VStack(spacing: 10) {
            if view.computer?.blocked == .humanCheck {
                humanCheck(inControl: inControl)
                    .transition(.opacity)
            }
            if case .failed(let reason) = view.control {
                failure(reason)
                    .transition(.opacity)
            }
            Button(action: inControl ? onRelease : onTake) {
                ZStack {
                    (inControl ? Text("Hand back to OpenDuet") : Text("Take over"))
                        .font(.system(size: fontSize, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .contentTransition(.opacity)
                        .opacity(toggling ? 0 : 1)
                    if toggling {
                        ProgressView().tint(Palette.filledButtonText)
                    }
                }
                .foregroundStyle(Palette.filledButtonText)
                .padding(.horizontal, 20)
                .frame(maxWidth: .infinity, minHeight: 54)
                .background(Capsule().fill(Palette.filledButton))
                .contentShape(Capsule())
                .opacity(enabled || toggling ? 1 : 0.4)
            }
            .buttonStyle(PressableButtonStyle(scale: 0.97))
            .disabled(!enabled)
            .accessibilityLabel(inControl ? Text("Hand back to OpenDuet") : Text("Take over"))
            .accessibilityValue(toggling ? Text("In progress") : Text(verbatim: ""))
            .accessibilityHint(inControl ? Text("OpenDuet takes a fresh look and carries on") : Text("Pauses OpenDuet so you can use the browser"))
        }
        .animation(.easeInOut(duration: 0.25), value: view.control)
        .animation(.easeInOut(duration: 0.25), value: inControl)
        .animation(.easeInOut(duration: 0.25), value: view.computer?.blocked)
    }

    private func humanCheck(inControl: Bool) -> some View {
        let lift = noteSize * 0.36
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            DuetIcon(glyph: .approval, size: noteSize + 3, tint: Palette.needsInput)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
            (inControl ? Text("Finish the site's human check, then hand back to OpenDuet.") : Text("This site wants a human check. Take over to finish it."))
                .foregroundStyle(Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: noteSize))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.needsInput.opacity(0.12)))
        .accessibilityElement(children: .combine)
    }

    private func failure(_ reason: String) -> some View {
        let lift = noteSize * 0.36
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            DuetIcon(glyph: .warning, size: noteSize + 2, tint: Palette.failure)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
            Text(verbatim: reason)
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: noteSize))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
        .accessibilityElement(children: .combine)
    }
}

/// M27 W6: the landscape full screen's right margin. The same states and actions as the capsule
/// (the haptics come from ComputerScreen, which owns both), in a column: Keyboard while the user
/// may type, then Take over / Hand back as a black circle (a spinner inside while it runs), each
/// with a short caption when the height allows (the keyboard up hides the captions and notes).
struct ComputerControlColumn: View {
    var view: ComputerViewState
    var resting = false
    var canType: Bool
    var typing: Bool
    /// the captions and the human-check / failure notes (FullScreenRules.Layout.captions)
    var captions: Bool
    var onKeyboard: () -> Void
    var onTake: () -> Void
    var onRelease: () -> Void

    @ScaledMetric(relativeTo: .caption) private var captionSize: CGFloat = 12

    private static let circle: CGFloat = 52
    private var enabled: Bool { ComputerDeployRules.canToggleControl(view, resting: resting) }
    private var toggling: Bool { ComputerDeployRules.isToggling(view) }

    var body: some View {
        let inControl = view.isUserInControl
        VStack(spacing: captions ? 14 : 10) {
            if captions, view.computer?.blocked == .humanCheck {
                note(glyph: .approval, tint: Palette.needsInput, text: inControl
                    ? Text("Finish the site's human check, then hand back to OpenDuet.")
                    : Text("This site wants a human check. Take over to finish it."))
                    .transition(.opacity)
            }
            if canType {
                item(caption: Text("Keyboard")) {
                    Button(action: onKeyboard) {
                        Image(systemName: typing ? "keyboard.chevron.compact.down" : "keyboard")
                            .glyphFont(19)
                            .foregroundStyle(Palette.primaryText)
                            .contentTransition(.symbolEffect(.replace))
                            .floatingCircle(Self.circle)
                    }
                    .buttonStyle(PressableButtonStyle(scale: 0.92))
                    .accessibilityLabel(typing ? Text("Hide keyboard") : Text("Type in OpenDuet's browser"))
                }
                .transition(.opacity)
            }
            item(caption: inControl ? Text("Hand back to OpenDuet") : Text("Take over")) {
                Button(action: inControl ? onRelease : onTake) {
                    ZStack {
                        Image(systemName: inControl ? "arrow.uturn.backward" : "hand.point.up.left.fill")
                            .font(.system(size: 20, weight: .semibold))
                            .contentTransition(.symbolEffect(.replace))
                            .opacity(toggling ? 0 : 1)
                        if toggling {
                            ProgressView().tint(Palette.filledButtonText)
                        }
                    }
                    .foregroundStyle(Palette.filledButtonText)
                    .frame(width: Self.circle, height: Self.circle)
                    .background(Circle().fill(Palette.filledButton))
                    .contentShape(Circle())
                    .opacity(enabled || toggling ? 1 : 0.4)
                }
                .buttonStyle(PressableButtonStyle(scale: 0.94))
                .disabled(!enabled)
                .accessibilityLabel(inControl ? Text("Hand back to OpenDuet") : Text("Take over"))
                .accessibilityValue(toggling ? Text("In progress") : Text(verbatim: ""))
                .accessibilityHint(inControl ? Text("OpenDuet takes a fresh look and carries on") : Text("Pauses OpenDuet so you can use the browser"))
            }
            if captions, case .failed(let reason) = view.control {
                note(glyph: .warning, tint: Palette.failure, text: Text(verbatim: reason))
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 8)
        .animation(.easeInOut(duration: 0.25), value: view.control)
        .animation(.easeInOut(duration: 0.25), value: inControl)
        .animation(.easeInOut(duration: 0.25), value: canType)
        .animation(.easeInOut(duration: 0.25), value: captions)
        .animation(.easeInOut(duration: 0.25), value: view.computer?.blocked)
    }

    /// A circle and its caption; the caption is hidden from VoiceOver (the circle says it).
    private func item(caption: Text, @ViewBuilder button: () -> some View) -> some View {
        VStack(spacing: 6) {
            button()
            if captions {
                caption
                    .font(.system(size: min(captionSize, 15), weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHidden(true)
                    .transition(.opacity)
            }
        }
    }

    private func note(glyph: DuetGlyph, tint: Color, text: Text) -> some View {
        VStack(spacing: 4) {
            DuetIcon(glyph: glyph, size: 15, tint: tint)
            text
                .font(.system(size: min(captionSize, 14)))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}
