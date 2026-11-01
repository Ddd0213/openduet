// The small status pill under the header mascot (prompt L94): white (#333333 in dark) with a
// #E4E4E4 hairline, 13 pt. In the main thread it is hidden when idle (nil) and shows the live
// status while working; a new status crossfades in and the capsule eases to the new width.
// In a channel (M4, L123) the idle pill names the channel: its tinted icon and "#name".
// M10 (plan 2.8): every status has a hand-drawn glyph before its words (StatusKey.pillIcon),
// and the glyph crossfades with the status: thinking a sparkle, memory a book, the web a globe,
// looking up a magnifier, a draft a pencil, commands the terminal, a task the checklist.
import SwiftUI

struct StatusPill: View {
    var status: StatusKey?
    /// The selected channel (nil = Everything): shown while nothing is running.
    var channel: Channel?

    @ScaledMetric(relativeTo: .footnote) private var glyphSize: CGFloat = 14

    var body: some View {
        ZStack {
            if let status {
                HStack(spacing: 5) {
                    ZStack {
                        StatusGlyph(status: status, size: glyphSize)
                            .id(status)
                            .transition(.opacity)
                    }
                    Text(status.title)
                        .font(Typography.pill)
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                        .contentTransition(.opacity)
                }
                .pillSurface(leading: 7)
                .transition(.opacity)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            } else if let channel {
                HStack(spacing: 5) {
                    ChannelGlyph(icon: channel.icon, color: channel.colorHex, size: 16)
                    Text(verbatim: "#\(channel.name)")
                        .font(Typography.pill)
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .pillSurface(leading: 6)
                .id(channel.id)
                .transition(.opacity)
            }
        }
        // Text and glyph changes crossfade and the pill fades in and out: no movement, so Reduce
        // Motion needs no special case here.
        .animation(.easeInOut(duration: 0.3), value: status)
        .animation(.easeInOut(duration: 0.3), value: channel?.id)
    }
}

/// The status's hand-drawn glyph in the pill's ink (DuetIcon, no accent at this size).
private struct StatusGlyph: View {
    var status: StatusKey
    var size: CGFloat

    var body: some View {
        switch status.pillIcon {
        case .card(let icon): DuetIcon(icon, size: size, tint: Palette.primaryText)
        case .glyph(let glyph): DuetIcon(glyph: glyph, size: size, tint: Palette.primaryText)
        }
    }
}

extension StatusKey {
    /// M10: the drawing before the pill's words. The server has no "running a command" key: a
    /// non-browser tool on the assistant's computer (a shell command) sends `working`, so `working`
    /// gets the terminal; the computer's browser and its waking workspace get the window and the
    /// computer; the rest take the nearest concept of the set.
    var pillIcon: DuetIconSource {
        switch self {
        case .thinking: .card(.sparkle)
        case .checkingMemory: .card(.book)
        case .searchingEmail: .glyph(.mail)
        case .checkingFiles: .glyph(.fileList)
        case .checkingCalendar: .glyph(.calendar)
        case .searchingWeb: .card(.globe)
        case .lookingUp: .glyph(.search)
        case .writingDraft: .card(.pencil)
        case .startingTask, .workingTasks: .glyph(.task)
        case .working: .glyph(.command)
        case .checking: .glyph(.eye)
        case .readingNow: .glyph(.read)
        case .workingBrowser: .glyph(.browser)
        case .wakingWorkspace: .glyph(.computer)
        }
    }
}

private extension View {
    /// Glass on iOS 26; the white (#333333) capsule with the #E4E4E4 hairline on iOS 18.
    func pillSurface(leading: CGFloat = 10) -> some View {
        padding(.leading, leading)
            .padding(.trailing, 10)
            .padding(.vertical, 5)
            .chromeSurface(Capsule(), shadow: false)
    }
}
