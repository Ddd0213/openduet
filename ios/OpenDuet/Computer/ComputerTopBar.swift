// The top of "OpenDuet's computer": ✕ on the left, the mascot with its status pill in the
// middle (the assistant's status while it drives, "You're in control" after Take over, "Waking
// OpenDuet's workspace" while the browser starts), and on the right M27's full-screen button while
// the live screen shows, then the keyboard button while the user drives, otherwise M20's "Let it
// sleep" while the browser is up or starting (L138). Upright only: the landscape full screen
// (ComputerFullScreen) has its own ✕ and column.
import SwiftUI

struct ComputerTopBar: View {
    var pill: ComputerPresentation.Pill
    /// landscape: the pill without the mascot circle
    var compact: Bool
    var showsKeyboard: Bool
    var typing: Bool
    /// M20: "Let it sleep" (ComputerDeployRules.sleepButton); the keyboard button wins the slot
    var sleep: ComputerDeployRules.SleepButton = .hidden
    var onClose: () -> Void
    var onKeyboard: () -> Void
    var onSleep: () -> Void = {}
    /// M27 W6: the full-screen button (shown whenever the live screen is)
    var showsFullScreen = false
    var onFullScreen: () -> Void = {}

    var body: some View {
        ChromeGlassGroup(spacing: 0) {
            if compact {
                HStack(alignment: .top) {
                    closeButton
                    Spacer(minLength: 8)
                    ComputerMascotPill(pill: pill, compact: compact)
                    Spacer(minLength: 8)
                    trailing
                }
            } else {
                // The pill hangs under the mascot, below the circles: overlaid so a second
                // circle on the right never pushes it off centre or narrows its text.
                ZStack(alignment: .top) {
                    ComputerMascotPill(pill: pill, compact: compact)
                        .padding(.horizontal, Metrics.headerCircle + 8)
                        .accessibilitySortPriority(2)
                    HStack(alignment: .top) {
                        closeButton
                            .accessibilitySortPriority(3)
                        Spacer(minLength: 8)
                        trailing
                            .accessibilitySortPriority(1)
                    }
                }
                .accessibilityElement(children: .contain)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: showsKeyboard)
        .animation(.easeInOut(duration: 0.2), value: sleep)
        .animation(.easeInOut(duration: 0.2), value: showsFullScreen)
    }

    private var closeButton: some View {
        FileChromeButton(systemImage: DuetGlyph.close.symbol, label: Text("Close"), action: onClose)
    }

    /// Full screen (when the live screen shows), then the keyboard while the user drives, else
    /// "Let it sleep", else an empty circle's space.
    private var trailing: some View {
        HStack(alignment: .top, spacing: 8) {
            if showsFullScreen {
                FileChromeButton(systemImage: "arrow.up.left.and.arrow.down.right", label: Text("Full screen"), action: onFullScreen)
                    .transition(.opacity)
            }
            if showsKeyboard {
                FileChromeButton(
                    systemImage: typing ? "keyboard.chevron.compact.down" : "keyboard",
                    label: typing ? Text("Hide keyboard") : Text("Type in OpenDuet's browser"),
                    action: onKeyboard
                )
                .transition(.opacity)
            } else if sleep != .hidden {
                ComputerSleepButton(state: sleep, action: onSleep)
                    .transition(.opacity)
            } else if !showsFullScreen {
                Color.clear.frame(width: Metrics.headerCircle, height: Metrics.headerCircle)
            }
        }
    }
}

/// M20 "Let it sleep": the ✕ / keyboard buttons' floating circle with a moon. A spinner inside
/// while POST /api/computer/sleep runs; dimmed like the disabled Take over capsule while the assistant
/// works, the user drives or another request runs.
private struct ComputerSleepButton: View {
    var state: ComputerDeployRules.SleepButton
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Image(systemName: "moon.zzz")
                    .glyphFont(17)
                    .foregroundStyle(Palette.primaryText)
                    .opacity(state == .busy ? 0 : 1)
                if state == .busy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Palette.primaryText)
                }
            }
            .floatingCircle(Metrics.headerCircle)
            .opacity(state == .disabled ? 0.4 : 1)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.92))
        .disabled(state != .enabled)
        .animation(.easeInOut(duration: 0.2), value: state)
        .accessibilityLabel(Text("Let it sleep"))
        .accessibilityValue(state == .busy ? Text("In progress") : Text(verbatim: ""))
        .accessibilityHint(Text("Closes OpenDuet's browser until it's needed again"))
    }
}

/// The 64 pt mascot circle with the status pill overlapping its bottom edge (like the shell
/// header); its pose follows the status. Pill text crossfades.
struct ComputerMascotPill: View {
    var pill: ComputerPresentation.Pill
    var compact: Bool

    var body: some View {
        // On glass the pill hangs just under the circle (overlapping glass would melt into one).
        VStack(spacing: LiquidGlass.isAvailable ? 4 : -8) {
            if !compact {
                // M29 (plan 6.2): the pill always shows; on iOS 18 it covers the circle's lower
                // edge, so the mascot sits 4 pt higher, clear of it (as in the shell header).
                DuetMascot(pose: MascotPose(status: poseStatus), size: 34, animated: true)
                    .offset(y: LiquidGlass.isAvailable ? 0 : -4)
                    .floatingCircle(Metrics.headerMascot, interactive: false)
            }
            text
                .font(Typography.pill)
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .contentTransition(.opacity)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .chromeSurface(Capsule(), shadow: false)
        }
        .padding(.top, compact ? 4 : 0)
        .animation(.easeInOut(duration: 0.3), value: pill)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var poseStatus: StatusKey? {
        switch pill {
        case .status(let key): key
        case .waking: .wakingWorkspace
        case .inControl, .idle: nil
        }
    }

    private var text: Text {
        switch pill {
        case .inControl: Text("You're in control")
        case .waking: Text(StatusKey.wakingWorkspace.title)
        case .status(let key): Text(key.title)
        case .idle: Text("OpenDuet's own computer")
        }
    }
}
