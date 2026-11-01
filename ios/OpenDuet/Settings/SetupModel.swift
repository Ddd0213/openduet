// M22 (#47) Everything → Setup's data: the server's rows (GET /api/setup; Check again is POST
// /api/setup/check and replaces them), and this phone's notification permission for the first
// row. A failed Check again keeps the rows on screen and says why under the button (429: "Try
// again in a moment"); a failed first load is the page's grey line with Retry.
import Foundation
import Observation
import UserNotifications

@MainActor @Observable
final class SetupModel {
    private(set) var api: APIClient?
    var info = Loadable<SetupInfo>()
    /// nil until read
    var notifications: NotificationAccess?
    /// Check again in flight
    var checking = false
    /// Check again failed: the line under the button (cleared by the next tap)
    var checkFailure: String?
    /// Check again answered: one success haptic
    var checks = 0

    func attach(_ api: APIClient?) {
        guard self.api == nil, let api else { return }
        self.api = api
    }

    func load() async {
        guard let api else {
            if info.value == nil { info.fail(String(localized: "Can't reach your server.")) }
            return
        }
        info.begin()
        do {
            info.finish(try await api.setup())
        } catch {
            if let reason = SettingsReason.line(for: error) { info.fail(reason) } else { info.loading = false }
        }
    }

    func check() async {
        guard !checking, let api else { return }
        checking = true
        checkFailure = nil
        do {
            info.finish(try await api.checkSetup())
            checks += 1
        } catch {
            checkFailure = SetupCheckFailure.line(for: error)
        }
        checking = false
    }

    // MARK: - This phone's notifications

    func refreshNotifications() async {
        notifications = await Self.readAccess()
    }

    /// Read off the main actor (the settings object stays there); only the answer comes back.
    nonisolated private static func readAccess() async -> NotificationAccess {
        access(await UNUserNotificationCenter.current().notificationSettings().authorizationStatus)
    }

    /// "Turn on": the system alert when never asked, otherwise iOS Settings.
    func turnOnNotifications(openSettings: () -> Void) async {
        switch SetupNotificationsRow.action(notifications) {
        case .ask?:
            _ = await NotificationPermission.request()
            await refreshNotifications()
        case .openSettings?:
            openSettings()
        case nil:
            break
        }
    }

    nonisolated static func access(_ status: UNAuthorizationStatus) -> NotificationAccess {
        switch status {
        case .authorized, .provisional, .ephemeral: .on
        case .denied: .off
        case .notDetermined: .undecided
        @unknown default: .undecided
        }
    }
}
