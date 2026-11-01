// The line under a live screen card: a globe, the current domain and a small state tag
// ("Live", or what the browser is doing when it isn't).
import SwiftUI

struct LiveBrowserFooter: View {
    enum Tag: Hashable { case live, ended, asleep, waking, none }

    var domain: String?
    var tag: Tag

    @ScaledMetric(relativeTo: .footnote) private var textSize: CGFloat = 13

    var body: some View {
        HStack(spacing: 6) {
            DuetIcon(glyph: .page, size: textSize + 1, tint: Palette.secondaryText)
            Group {
                if let domain, !domain.isEmpty {
                    Text(verbatim: domain)
                } else {
                    Text("No page open")
                }
            }
            .font(.system(size: textSize, weight: .medium))
            .foregroundStyle(Palette.primaryText)
            .lineLimit(1)
            .truncationMode(.middle)
            Spacer(minLength: 8)
            switch tag {
            case .live:
                BrowserLiveTag().transition(.opacity)
            case .ended:
                quiet(Text("Ended"))
            case .asleep:
                quiet(Text("Asleep"))
            case .waking:
                quiet(Text("Waking up"))
            case .none:
                EmptyView()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .animation(.easeInOut(duration: 0.25), value: tag)
    }

    private func quiet(_ text: Text) -> some View {
        text
            .font(.system(size: textSize - 1, weight: .medium))
            .foregroundStyle(Palette.secondaryText)
            .lineLimit(1)
            .transition(.opacity)
    }
}

extension LiveBrowserFooter.Tag {
    /// The tag for the assistant's computer as it is now.
    init(_ computer: ComputerState?) {
        guard let computer, computer.available else { self = .none; return }
        switch computer.browser {
        case .off: self = .asleep
        case .starting: self = .waking
        case .ready: self = .live
        }
    }
}
