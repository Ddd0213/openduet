// The middle of "OpenDuet's computer": a page-shaped skeleton while it loads, the grey reason
// with Retry, a one-line note when the server has no computer, "Waking OpenDuet's workspace"
// while the browser starts, or the live screen. The stream stays open the whole time the view
// is up, except (M20) on a server without the assistant's computer and after "Let it sleep": then it
// shows the browser asleep and lets the stream go, and a tap wakes it.
// M27 W6: the page-shaped skeleton and the live screen sit at the top, right under the app's
// tab strip and address bar (`joinedTop`: square top corners); `dismissible` is false in the
// landscape full screen (no swipe-down close there).
import SwiftUI
import UIKit

struct ComputerCanvas: View {
    var view: ComputerViewState
    var screen: LiveScreen?
    /// M20: "Let it sleep" answered: shown asleep until `onWake` (ComputerScreen's state)
    var resting = false
    var onInput: (ComputerClientMessage) -> Void
    var onReload: () -> Void
    var onWake: () -> Void = {}
    var onDismissDrag: (_ translation: CGFloat, _ ended: Bool, _ predicted: CGFloat) -> Void
    /// M27 W6: the bar is right above
    var joinedTop = false
    /// M27 W6: the swipe down on the live screen closes the view
    var dismissible = true

    var body: some View {
        let content = ComputerDeployRules.body(view)
        ZStack(alignment: .top) {
            if resting && content != .unavailable {
                ComputerAsleepView(onWake: onWake)
                    .transition(.opacity)
            } else {
                switch content {
                case .loading:
                    BrowserPageSkeleton()
                        .background(BrowserPalette.body)
                        .clipShape(ScreenCorners(joinedTop: joinedTop))
                        .aspectRatio(16.0 / 10.0, contentMode: .fit)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text("Loading OpenDuet's computer"))
                case .failed(let reason):
                    InlineRetryLine(reason: reason, onRetry: onReload)
                        .frame(maxHeight: .infinity)
                case .unavailable:
                    EmptyStateView(systemImage: DuetGlyph.computer.symbol, message: "OpenDuet's computer isn't set up on this server yet.")
                        .frame(maxHeight: .infinity)
                case .waking:
                    ComputerWakingView()
                case .screen:
                    RemoteScreen(
                        screen: screen, view: view, onInput: onInput, onDismissDrag: onDismissDrag,
                        joinedTop: joinedTop, dismissible: dismissible
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeInOut(duration: 0.3), value: content)
        .animation(.easeInOut(duration: 0.3), value: resting)
        // The stream wakes the browser: none while it rests or goes to sleep, nor to a server
        // without it.
        .liveScreenDemand(screen, active: ComputerDeployRules.wantsStream(view, resting: resting))
    }
}

/// M20: after "Let it sleep": the still mascot and one line; tapping wakes the browser (the view
/// asks for the stream again, which starts it, then "Waking OpenDuet's workspace").
struct ComputerAsleepView: View {
    var onWake: () -> Void

    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 15

    var body: some View {
        Button(action: onWake) {
            VStack(spacing: 14) {
                DuetMascot(pose: .idle, size: 40)
                    .floatingCircle(76, interactive: false)
                Text("OpenDuet's browser is asleep. Tap to wake it.")
                    .font(.system(size: textSize, weight: .medium))
                    .foregroundStyle(Palette.secondaryText)
                    .multilineTextAlignment(.center)
            }
            .padding(24)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("OpenDuet's browser is asleep"))
        .accessibilityHint(Text("Wakes OpenDuet's browser"))
        .accessibilityAddTraits(.isButton)
    }
}

/// "Waking OpenDuet's workspace": the mascot over a still page while the browser starts.
struct ComputerWakingView: View {
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 15

    var body: some View {
        VStack(spacing: 14) {
            DuetMascot(pose: MascotPose(status: .wakingWorkspace), size: 40, animated: true)
                .floatingCircle(76, interactive: false)
            Text(StatusKey.wakingWorkspace.title)
                .font(.system(size: textSize, weight: .medium))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// M27 W6: the skeleton's corners: all rounded, or only the bottom ones under the bar.
struct ScreenCorners: Shape {
    var joinedTop: Bool
    var radius: CGFloat = 12

    func path(in rect: CGRect) -> Path {
        let top = joinedTop ? 0 : radius
        return UnevenRoundedRectangle(
            topLeadingRadius: top, bottomLeadingRadius: radius, bottomTrailingRadius: radius, topTrailingRadius: top,
            style: .continuous
        ).path(in: rect)
    }
}

/// The live screen with its newest frame (decoded off the main thread), a skeleton before the
/// first one and a "Reconnecting…" chip while the stream is down.
struct RemoteScreen: View {
    var screen: LiveScreen?
    var view: ComputerViewState
    var onInput: (ComputerClientMessage) -> Void
    var onDismissDrag: (_ translation: CGFloat, _ ended: Bool, _ predicted: CGFloat) -> Void
    var joinedTop = false
    var dismissible = true

    @State private var image: UIImage?
    @State private var shownFrame = -1

    var body: some View {
        let frameNumber = screen?.frameNumber ?? 0
        let reconnecting = screen?.connection == .reconnecting
        let pixels = CGSize(width: screen?.pixelWidth ?? 0, height: screen?.pixelHeight ?? 0)
        let domain = view.computer?.domain ?? ""
        ZStack(alignment: .top) {
            if image == nil {
                BrowserPageSkeleton()
                    .background(BrowserPalette.body)
                    .clipShape(ScreenCorners(joinedTop: joinedTop))
                    .aspectRatio(16.0 / 10.0, contentMode: .fit)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .transition(.opacity)
            }
            RemoteScreenView(
                image: image, pixelSize: pixels, interactive: view.isUserInControl,
                label: String(localized: "OpenDuet's browser, \(domain)"),
                value: view.isUserInControl ? String(localized: "You're in control") : String(localized: "OpenDuet is in control"),
                hint: view.isUserInControl ? String(localized: "Tap to click, drag to scroll, touch and hold then move to drag, pinch to zoom") : String(localized: "Pinch to zoom"),
                onInput: onInput, onDismissDrag: onDismissDrag,
                joinedTop: joinedTop, dismissible: dismissible
            )
            .opacity(image == nil ? 0 : (reconnecting ? 0.5 : 1))
            if reconnecting {
                Text("Reconnecting…")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .chromeSurface(Capsule(), shadow: false)
                    .padding(.top, 10)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: image == nil)
        .animation(.easeInOut(duration: 0.25), value: reconnecting)
        .task(id: frameNumber) {
            guard let data = screen?.frame else { return }
            let number = frameNumber
            let decoded = await LiveFrameDecoder.decode(data)
            if let decoded, number > shownFrame {
                shownFrame = number
                image = decoded
            }
        }
    }
}
