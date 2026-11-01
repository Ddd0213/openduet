// When a `notification` event becomes a local UNNotification and when a delivered one shows as a
// banner (L78). Local delivery always happens when the app isn't active or the event's thread
// or task isn't on screen; in the foreground, the one being looked at never notifies. M29: quiet
// hours (a passive one is silent and stays in Notification Center), the APNs environment read
// from the provisioning profile, and the app icon badge. Foundation + DuetRoute only, so the Mac
// host tests drive it; NotificationsCoordinator does the posting.
import Foundation

/// What the user is looking at right now.
struct NotificationScreen: Hashable, Sendable {
    /// the app is in the foreground (UIApplication.applicationState == .active)
    var appActive: Bool
    /// the main shell is up (not sign-in, the launch screen or onboarding)
    var shellVisible: Bool
    /// the chat thread's channel (the main channel for Everything)
    var channelId: String?
    /// the open task detail, nil = none
    var taskId: String?
    /// the tab under it (a channel's thread is only on screen on Chat)
    var tab: ShellTab = .chat
}

enum NotificationRules {
    /// Older events (a long catch-up after the app was suspended) don't notify again; the remote
    /// push, if any, already did.
    static let freshness: TimeInterval = 10 * 60

    /// Whether the event's route is the thing on screen: its channel's thread on the Chat tab
    /// with no task detail over it, or its task detail.
    static func isOnScreen(route: String, _ screen: NotificationScreen) -> Bool {
        guard screen.appActive, screen.shellVisible, let url = URL(string: route), let parsed = DuetRoute(url) else { return false }
        switch parsed {
        case .channel(let id): return screen.taskId == nil && screen.tab == .chat && screen.channelId == id
        case .task(let id): return screen.taskId == id
        default: return false
        }
    }

    /// A `notification` event: post a local notification?
    static func shouldPostLocal(route: String, createdAt: Date, now: Date, _ screen: NotificationScreen) -> Bool {
        guard now.timeIntervalSince(createdAt) <= freshness else { return false }
        return !isOnScreen(route: route, screen)
    }

    /// `willPresent` in the foreground: show the banner unless its thread or task is on screen. A
    /// remote push is left out while the live stream is connected, because the same event
    /// already came through it as a local notification.
    static func shouldPresent(route: String?, isRemote: Bool, streamLive: Bool, _ screen: NotificationScreen) -> Bool {
        if isRemote && streamLive { return false }
        guard let route else { return true }
        return !isOnScreen(route: route, screen)
    }

    /// The APNs device token as lowercase hex (RegisterDeviceRequest.token).
    static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - M21: one notification per thing, and withdrawing it

    /// A `notification` event's request identifier: its collapse id (task-<id>, approval-<id>,
    /// message-<id>), so a newer one replaces the older and a decided approval's can be removed;
    /// events from before M21 keep one per event.
    static func requestIdentifier(eventId: Int64, collapseId: String?) -> String {
        if let collapseId, !collapseId.isEmpty { return collapseId }
        return "event-\(eventId)"
    }

    /// Groups a thread's or a task's notifications: the route without ?message=.
    static func threadIdentifier(route: String) -> String {
        guard var components = URLComponents(string: route), components.query != nil else { return route }
        components.query = nil
        return components.string ?? route
    }

    /// A silent push's `withdraw: ["approval-<id>", ...]` (empty when it has none).
    static func withdrawIds(in userInfo: [AnyHashable: Any]) -> Set<String> {
        guard let list = userInfo["withdraw"] as? [Any] else { return [] }
        return Set(list.compactMap { $0 as? String }.filter { !$0.isEmpty })
    }

    /// The collapse id of a delivered notification: a push carries it in its payload, a local
    /// one in its userInfo (both `collapseId`).
    static func collapseId(in userInfo: [AnyHashable: Any]) -> String? {
        (userInfo["collapseId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Whether a delivered notification is one of `ids`: by its collapse id, or by its request
    /// identifier (a local notification's is the collapse id).
    static func isWithdrawn(identifier: String, userInfo: [AnyHashable: Any], ids: Set<String>) -> Bool {
        if ids.contains(identifier) { return true }
        return collapseId(in: userInfo).map(ids.contains) ?? false
    }

    /// A live `approval` event: once it is no longer pending, its notification goes.
    static func withdrawId(for approval: Approval) -> String? {
        approval.status == .pending ? nil : "approval-\(approval.id)"
    }

    // MARK: - M29: quiet hours (passive)

    /// How a notification interrupts (UNNotificationInterruptionLevel's two levels used here).
    enum Interruption: Hashable, Sendable {
        /// sound, banner, lights the screen
        case active
        /// the user's quiet hours: Notification Center only, no sound, the screen stays dark
        case passive

        /// A `notification` event's `passive`.
        init(passive: Bool) { self = passive ? .passive : .active }

        /// A local notification plays the default sound unless it is passive.
        var playsSound: Bool { self == .active }
    }

    /// What `willPresent` shows (UNNotificationPresentationOptions).
    enum Presentation: Hashable, Sendable { case banner, list, sound }

    /// `willPresent` in the foreground: nothing when `shouldPresent` says no; a passive one
    /// (a local one marked so, or a push with `interruption-level: passive`) goes to Notification
    /// Center only, no banner and no sound; the rest banner, list and sound.
    static func presentation(show: Bool, _ interruption: Interruption) -> Set<Presentation> {
        guard show else { return [] }
        return interruption == .passive ? [.list] : [.banner, .list, .sound]
    }

    // MARK: - M29: the APNs environment of this build

    /// `aps-environment` in a provisioning profile (embedded.mobileprovision: a CMS envelope
    /// around an XML plist; the plist is read between `<?xml` and `</plist>`): "development",
    /// "production", or nil when it can't be read or has no such entitlement.
    static func apsEnvironment(profile: Data) -> String? {
        guard let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex)
        else { return nil }
        let xml = Data(profile[start.lowerBound..<end.upperBound])
        guard let plist = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any] else { return nil }
        return entitlements["aps-environment"] as? String
    }

    /// Which APNs environment the device token belongs to (POST /api/devices). It follows the
    /// signing, not the build configuration: a Release build signed for development gets a
    /// sandbox token. `profile` nil = no embedded.mobileprovision (App Store, TestFlight):
    /// production. A profile that can't be read, or has no aps-environment, falls back to the
    /// build configuration (`debugBuild`).
    static func apnsEnvironment(profile: Data?, debugBuild: Bool) -> RegisterDeviceRequest.Environment {
        guard let profile else { return .production }
        switch apsEnvironment(profile: profile) {
        case "development": return .sandbox
        case "production": return .production
        default: return debugBuild ? .sandbox : .production
        }
    }

    // MARK: - M29: the app icon badge

    /// The number on the app icon: what waits on the user (the Tasks tab badge, from GET
    /// /api/needs-you); 0 (no badge) when signed out.
    static func appBadge(waitingOnYou: Int, signedIn: Bool) -> Int {
        signedIn ? max(0, waitingOnYou) : 0
    }
}
