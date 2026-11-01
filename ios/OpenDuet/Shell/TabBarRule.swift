// M21 (prompt L152, user's phone screenshot 2026-10-28): with an artifact added as a 4th tab, the
// four tabs show icons only, the same width each (its full title had pushed the bar out of
// shape); VoiceOver still reads every tab's name, the 4th its artifact's title. With 3 tabs they
// keep their text. Pure Foundation (host-tested); MainShellView draws it.
import Foundation

enum TabBarRule {
    /// Whether the tabs show their text under the icon.
    static func showsTitles(tabCount: Int) -> Bool {
        tabCount <= 3
    }

    /// The tab bar's tabs: Chat, Tasks, Make, and the pinned artifact when there is one.
    static func tabCount(hasPinned: Bool) -> Int {
        hasPinned ? 4 : 3
    }

    /// What VoiceOver reads for the 4th tab: the artifact's title (trimmed), nil when it has none
    /// (the UI then reads "Pinned").
    static func pinnedLabel(title: String) -> String? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
