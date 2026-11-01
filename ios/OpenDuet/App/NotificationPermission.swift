// The real iOS notification permission (prompt L31; M4 also asks at launch per L170).
import UserNotifications

enum NotificationPermission {
    /// True once the user has allowed notifications (authorized, provisional or ephemeral).
    static func isAllowed() async -> Bool {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        return [.authorized, .provisional, .ephemeral].contains(status)
    }

    static func isUndecided() async -> Bool {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .notDetermined
    }

    /// Shows the system alert if the user never decided; otherwise answers immediately.
    static func request() async -> Bool {
        if await isUndecided() {
            return (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        }
        return await isAllowed()
    }
}
