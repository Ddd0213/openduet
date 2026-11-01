// The voice call's compact bar under the header (plan 2.7: not full screen, the thread stays):
// the call's live waveform, its phase ("Connecting…", "Listening", "Speaking", "Reconnecting…",
// "Muted") and timer, mute and end (end confirms nothing: it's a call), and the live captions.
// On another channel it shrinks to "On a call in <channel>"; a tap goes there. A failed call
// shows its reason and Close.
import SwiftUI

struct CallBar: View {
    var call: CallSession
    /// The menu, for where the call is and whether its thread is on screen.
    var menu: MenuState
    /// The main thread's channel (the menu lists it as "Everything", not among its channels).
    var mainChannelId: String?
    /// Pulls the bar up to the header like the offline bar (0 under the offline bar).
    var topInset: CGFloat = 0
    var onGoToCall: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 14
    @ScaledMetric(relativeTo: .footnote) private var buttonSize: CGFloat = 34

    var body: some View {
        // Nothing at all without a call: the header keeps its height.
        VStack(spacing: 0) {
            if call.isActive {
                Group {
                    if case .failed(let reason, _)? = call.phase {
                        failed(reason)
                    } else if isHere {
                        full
                    } else {
                        compact
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, topInset)
                .padding(.bottom, 8)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.38, dampingFraction: 0.88), value: call.isActive)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.38, dampingFraction: 0.88), value: isHere)
        .sensoryFeedback(.warning, trigger: call.phase?.isFailed == true) { _, failed in failed }
    }

    /// The thread on screen is the call's (the main thread: no channel selected).
    private var isHere: Bool {
        guard let channelId = call.channelId else { return true }
        return (menu.selectedChannelId ?? mainChannelId) == channelId
    }

    /// "#shop", or "Everything" for the main thread.
    private var channelName: String {
        if let channel = menu.channels.first(where: { $0.id == call.channelId }) { return "#\(channel.name)" }
        return String(localized: "Everything")
    }

    // MARK: - On the call's thread

    private var full: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                LiveCallWaveform(call: call, tint: Palette.accent, size: 20)
                status
                Spacer(minLength: 4)
                circle(muteLabel, systemImage: call.muted ? "mic.slash.fill" : "mic.fill", tint: call.muted ? Palette.accent : Palette.primaryText) {
                    call.toggleMute()
                }
                circle(Text("End call"), systemImage: "phone.down.fill", tint: .white, fill: Palette.failure) {
                    call.end()
                }
            }
            if !call.lines.isEmpty {
                CallCaptions(lines: call.lines, onInterrupt: call.interrupt)
                    .transition(.opacity)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .chromeSurface(RoundedRectangle(cornerRadius: 22, style: .continuous), shadow: false)
        .animation(.easeInOut(duration: 0.2), value: call.lines.isEmpty)
        .transition(.opacity)
    }

    private var status: some View {
        HStack(spacing: 6) {
            Text(verbatim: phaseText)
                .font(.system(size: fontSize, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .contentTransition(.opacity)
            Text(verbatim: CallCopy.timer(call.seconds))
                .font(.system(size: fontSize).monospacedDigit())
                .foregroundStyle(Palette.secondaryText)
        }
        .lineLimit(1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Voice call, \(phaseText)"))
        .accessibilityValue(Text(verbatim: PhraseFormatter.duration(Double(call.seconds), locale: locale)))
    }

    // MARK: - Elsewhere

    private var compact: some View {
        Button { if let channelId = call.channelId { onGoToCall(channelId) } } label: {
            HStack(spacing: 8) {
                LiveCallWaveform(call: call, tint: Palette.accent, size: 16)
                Text("On a call in \(channelName)")
                    .font(.system(size: fontSize - 1, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(1)
                Text(verbatim: CallCopy.timer(call.seconds))
                    .font(.system(size: fontSize - 1).monospacedDigit())
                    .foregroundStyle(Palette.secondaryText)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .chromeSurface(Capsule(), shadow: false)
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.96))
        .frame(maxWidth: .infinity)
        .accessibilityHint(Text("Opens the call's channel"))
        .transition(.opacity)
    }

    // MARK: - Failed

    private func failed(_ reason: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            DuetIcon(glyph: .warning, size: fontSize + 2, tint: Palette.failure)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("The call ended")
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                Text(verbatim: reason)
                    .font(.system(size: fontSize - 1))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button(action: call.dismiss) {
                Text("Close")
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundStyle(Palette.accent)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 4)
        .chromeSurface(RoundedRectangle(cornerRadius: 22, style: .continuous), shadow: false)
        .transition(.opacity)
    }

    // MARK: - Parts

    private var phaseText: String {
        call.phase.flatMap { CallCopy.phase($0, muted: call.muted) } ?? ""
    }

    private var muteLabel: Text { call.muted ? Text("Unmute") : Text("Mute") }

    private func circle(_ label: Text, systemImage: String, tint: Color, fill: Color = Palette.tile, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: buttonSize * 0.42, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: buttonSize, height: buttonSize)
                .background(Circle().fill(fill))
                .frame(width: max(buttonSize, 44), height: max(buttonSize, 44))
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.88))
        .accessibilityLabel(label)
    }
}
