// M22: duet://settings/<page> (Setup's fixes, show_tasks cards, links): the settings sheet (the
// profile sheet, M16) opened at that page: Models, Apps and connectors, Voice, Setup or Who
// the assistant is. openRoute's `.settings` case calls openSettings (wired at merge). ShellPresentation
// only names Models and Voice, so the page goes through SettingsPageRequest, which the sheet
// reads when it opens and follows while it is up.
import Foundation
import Observation

/// The settings page a link asked for. ProfileSheet takes `wanted` when it opens without a page
/// of its own and switches to it when `token` changes while it is on screen.
@MainActor @Observable
final class SettingsPageRequest {
    static let shared = SettingsPageRequest()

    @ObservationIgnored private(set) var wanted: DuetRoute.SettingsPage?
    /// bumped by every ask, so an open sheet hears the same page twice
    private(set) var token = 0

    func ask(_ page: DuetRoute.SettingsPage) {
        wanted = page
        token += 1
    }

    /// The asked page, once.
    func take() -> DuetRoute.SettingsPage? {
        defer { wanted = nil }
        return wanted
    }
}

extension ChatStore {
    /// Opens Everything's settings at `page`. The settings sheet already up switches page in
    /// place; another sheet (the OpenDuet sheet, Usage) goes down first, so one sheet never
    /// replaces the other in place.
    func openSettings(_ page: DuetRoute.SettingsPage) {
        guard !tornDown else { return }
        switch account.presented {
        case .profile?, .models?, .voice?:
            SettingsPageRequest.shared.ask(page)
        case nil:
            SettingsPageRequest.shared.ask(page)
            present(.profile)
        case .assistant?, .usage?:
            dismissSheet()
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(450))
                guard let self, !self.tornDown, self.account.presented == nil else { return }
                SettingsPageRequest.shared.ask(page)
                self.present(.profile)
            }
        }
    }
}
