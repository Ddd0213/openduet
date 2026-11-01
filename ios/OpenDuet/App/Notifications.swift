// Notifications on the app side (prompt L78, L170): asks for permission at launch when it was
// never decided; turns `notification` events into local UNNotifications (NotificationRules
// decides, PhraseFormatter renders title and body in the app's language); shows banners in the
// foreground unless their thread or task is on screen; opens a tapped notification's thread or
// task; registers for remote push only when the server's NOTIFY_PROVIDER is apns (POST
// /api/devices with the hex token, DELETE on sign-out, see SessionStore); and keeps the event
// stream alive in the background for as long as iOS allows. ntfy and bark need nothing here.
// M29: quiet hours (a passive notification is silent, Notification Center only, also in the
// foreground), the token's APNs environment from the provisioning profile, and the app icon
// badge (the Tasks tab's Waiting on you count; 0 after sign-out).
import OSLog
import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class NotificationsCoordinator: NSObject {
    static let shared = NotificationsCoordinator()

    /// Set by RootView: the signed-in session (chat state for the on-screen rules).
    weak var session: SessionStore?

    private struct PushContext {
        var server: ServerAddress
        var client: APIClient
        var userId: String
    }

    private var push: PushContext?
    private var deviceToken: Data?
    /// A notification tap or duet:// link that arrived before the shell was up (cold start).
    private var pendingRoute: URL?
    /// Event ids already posted (both streams can carry the same event).
    private var posted: [Int64] = []
    private var askedThisLaunch = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    /// M21: collapse ids of decided approvals waiting to be withdrawn, and the task doing it.
    private var pendingWithdraw = Set<String>()
    private var withdrawTask: Task<Void, Never>?
    /// M29: the icon badge waiting to be set, and the task setting it.
    private var badgeWanted: Int?
    private var badgeTask: Task<Void, Never>?
    /// Made per notification: the app's locale (AppLocale) and now as the banner goes up, so a
    /// "today at 5:00 PM" is counted from the right day.
    private var formatter: PhraseFormatter { PhraseFormatter() }

    /// nonisolated (Logger is Sendable): `withdraw` logs from a silent push too.
    nonisolated private static let log = Logger(subsystem: "dev.openduet.OpenDuet", category: "notifications")

    // MARK: - Session

    /// A session started: remote push only when the server pushes through APNs.
    func sessionStarted(server: ServerAddress, client: APIClient, user: CurrentUser) {
        guard user.features.push == .apns else {
            push = nil
            return
        }
        push = PushContext(server: server, client: client, userId: user.id)
        UIApplication.shared.registerForRemoteNotifications()
        if deviceToken != nil { registerDevice() }
    }

    /// Signed out or expired: forget the session and clear what it delivered (M29: the icon badge too).
    func sessionEnded() {
        push = nil
        pendingRoute = nil
        posted = []
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
        setBadge(NotificationRules.appBadge(waitingOnYou: 0, signedIn: false))
    }

    // MARK: - App icon badge (M29)

    /// GET /api/needs-you answered (ChatStore.onWaitingOnYou): the icon shows the Tasks tab's
    /// number. A push's `aps.badge` carries the same count while the app isn't running.
    func waitingOnYouChanged(_ count: Int) {
        setBadge(NotificationRules.appBadge(waitingOnYou: count, signedIn: session?.phase == .signedIn))
    }

    /// One setBadgeCount at a time, the latest number last. Without notification or badge
    /// permission iOS refuses it: nothing to show, so it is only logged.
    private func setBadge(_ count: Int) {
        badgeWanted = count
        guard badgeTask == nil else { return }
        badgeTask = Task {
            while let count = badgeWanted {
                badgeWanted = nil
                do {
                    try await UNUserNotificationCenter.current().setBadgeCount(count)
                } catch {
                    Self.log.debug("Couldn't set the app badge: \(String(describing: error), privacy: .public)")
                }
            }
            badgeTask = nil
        }
    }

    // MARK: - Permission (L170)

    /// The shell appeared at launch or after sign-in. Ask once if the user never decided, unless
    /// onboarding (whose page 6 asks) was just shown in this launch.
    func shellAppeared(afterOnboarding: Bool) {
        shellMayBeVisible()
        guard !askedThisLaunch else { return }
        askedThisLaunch = true
        guard !afterOnboarding else { return }
        Task {
            guard await NotificationPermission.isUndecided() else { return }
            _ = await NotificationPermission.request()
        }
    }

    /// The shell may be on screen now: hand over a route that waited for it.
    func shellMayBeVisible() {
        guard let route = pendingRoute, shellVisible, let chat = session?.chat else { return }
        pendingRoute = nil
        chat.openRoute(route)
    }

    // MARK: - Remote push

    func didRegister(deviceToken token: Data) {
        deviceToken = token
        registerDevice()
    }

    func didFailToRegister(_ error: any Error) {
        // Expected without the aps-environment entitlement (free accounts, simulator builds).
        Self.log.notice("Remote push registration failed: \(String(describing: error), privacy: .public)")
    }

    private func registerDevice() {
        guard let push, let token = deviceToken else { return }
        let body = RegisterDeviceRequest(
            provider: .apns,
            token: NotificationRules.hex(token),
            environment: Self.apnsEnvironment,
            locale: RequestContext.locale
        )
        Task {
            do {
                let id = try await push.client.registerDevice(body)
                guard self.push?.userId == push.userId, self.push?.server == push.server else { return }
                SessionDefaults.setDeviceId(id, server: push.server, userId: push.userId)
            } catch {
                Self.log.error("POST /api/devices failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// M29: the environment of this build's token, from embedded.mobileprovision's aps-environment
    /// (NotificationRules.apnsEnvironment), read once. A Release build installed with a
    /// development profile gets sandbox tokens; reporting production there made APNs refuse them
    /// and the server drop the device. The simulator has no profile and only sandbox tokens.
    private static let apnsEnvironment: RegisterDeviceRequest.Environment = {
        #if targetEnvironment(simulator)
        return .sandbox
        #else
        return signedEnvironment
        #endif
    }()

    /// The environment embedded.mobileprovision names. A profile that exists but can't be read
    /// is empty data: no aps-environment, so the build configuration decides.
    private static var signedEnvironment: RegisterDeviceRequest.Environment {
        #if DEBUG
        let debugBuild = true
        #else
        let debugBuild = false
        #endif
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").map { url in
            (try? Data(contentsOf: url)) ?? Data()
        }
        return NotificationRules.apnsEnvironment(profile: profile, debugBuild: debugBuild)
    }

    // MARK: - Local notifications (L78)

    /// A `notification` event from either stream.
    func deliver(_ event: DuetEvent, _ notification: DuetEvent.Notification) {
        guard !posted.contains(event.id) else { return }
        guard NotificationRules.shouldPostLocal(route: notification.route, createdAt: event.createdAt, now: .now, screen) else { return }
        posted.append(event.id)
        if posted.count > 200 { posted.removeFirst(posted.count - 200) }
        let content = UNMutableNotificationContent()
        let title = formatter.string(notification.title)
        content.title = title.isEmpty ? "OpenDuet" : title
        content.body = formatter.string(notification.body)
        // M29: in the user's quiet hours it goes to Notification Center only: no sound, the
        // screen stays dark.
        let interruption = NotificationRules.Interruption(passive: notification.passive)
        content.sound = interruption.playsSound ? .default : nil
        content.interruptionLevel = interruption.level
        content.threadIdentifier = NotificationRules.threadIdentifier(route: notification.route)
        var userInfo: [AnyHashable: Any] = ["route": notification.route]
        if let collapseId = notification.collapseId { userInfo["collapseId"] = collapseId }
        content.userInfo = userInfo
        // M21: one per thing (its collapse id): a newer one replaces the older in Notification
        // Center, and a decided approval's can be taken back (withdraw).
        let identifier = NotificationRules.requestIdentifier(eventId: event.id, collapseId: notification.collapseId)
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        Task {
            do {
                try await UNUserNotificationCenter.current().add(request)
            } catch {
                Self.log.error("Couldn't post a local notification: \(String(describing: error), privacy: .public)")
            }
        }
    }

    // MARK: - Withdraw (M21)

    /// A live `approval` event: once decided, its notification (remote push or local) goes.
    func approvalChanged(_ approval: Approval) {
        guard let id = NotificationRules.withdrawId(for: approval) else { return }
        withdrawSoon([id])
    }

    /// A burst of decided approvals (a replay) reads Notification Center once.
    private func withdrawSoon(_ ids: Set<String>) {
        pendingWithdraw.formUnion(ids)
        guard withdrawTask == nil else { return }
        withdrawTask = Task {
            while !pendingWithdraw.isEmpty {
                let batch = pendingWithdraw
                pendingWithdraw = []
                await Self.withdraw(batch)
            }
            withdrawTask = nil
        }
    }

    /// Removes the delivered notifications (and any local one not shown yet) whose collapse id
    /// is in `ids`: a push's payload `collapseId`, a local notification's identifier.
    nonisolated static func withdraw(_ ids: Set<String>) async {
        guard !ids.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        let delivered = await center.deliveredNotifications()
        let gone = delivered.map(\.request).filter {
            NotificationRules.isWithdrawn(identifier: $0.identifier, userInfo: $0.content.userInfo, ids: ids)
        }.map(\.identifier)
        if !gone.isEmpty { center.removeDeliveredNotifications(withIdentifiers: gone) }
        center.removePendingNotificationRequests(withIdentifiers: Array(ids))
        log.notice("Withdrew \(gone.count, privacy: .public) delivered notification(s)")
    }

    /// What is on screen right now.
    private var screen: NotificationScreen {
        NotificationScreen(
            appActive: UIApplication.shared.applicationState == .active,
            shellVisible: shellVisible,
            channelId: session?.chat?.threadChannelId,
            taskId: session?.chat?.openTaskId,
            tab: session?.chat?.tab ?? .chat
        )
    }

    private var shellVisible: Bool {
        guard let session else { return false }
        return session.phase == .signedIn && !session.needsOnboarding && session.chat != nil
    }

    fileprivate func shouldPresent(route: String?, isRemote: Bool) -> Bool {
        NotificationRules.shouldPresent(route: route, isRemote: isRemote, streamLive: session?.chat?.isStreamLive == true, screen)
    }

    /// A notification tap or a duet:// link: its thread or task (after launch, once the shell is up).
    func open(_ url: URL) {
        // M17: duet://oauth/callback belongs to the web sign-in sheet (which reads it itself); if
        // iOS ever hands it here, it isn't a route: no navigation, no log (it carries a code).
        if OAuthCallback.isCallback(url) { return }
        if shellVisible, let chat = session?.chat {
            chat.openRoute(url)
        } else {
            pendingRoute = url
        }
    }

    // MARK: - Background (L78)

    /// The app went to the background: keep GET /api/events open for as long as iOS allows, so
    /// `notification` events still post locally; at expiry the stream closes (`onExpire`) and the
    /// next foreground catches up with Last-Event-ID.
    func didEnterBackground(onExpire: @escaping @MainActor () -> Void) {
        endBackgroundTask()
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "events") { [weak self] in
            MainActor.assumeIsolated {
                onExpire()
                self?.endBackgroundTask()
            }
        }
        if backgroundTask == .invalid { onExpire() }
    }

    func didBecomeActive() {
        endBackgroundTask()
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationsCoordinator: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let route = Self.route(in: notification.request.content.userInfo)
        let isRemote = notification.request.trigger is UNPushNotificationTrigger
        // M29: passive (quiet hours): set on a local one by `deliver`, on a push by its
        // `interruption-level`; it stays out of the foreground too.
        let interruption = NotificationRules.Interruption(notification.request.content.interruptionLevel)
        let show = await shouldPresent(route: route, isRemote: isRemote)
        return Self.options(NotificationRules.presentation(show: show, interruption))
    }

    nonisolated private static func options(_ presentation: Set<NotificationRules.Presentation>) -> UNNotificationPresentationOptions {
        var options: UNNotificationPresentationOptions = []
        if presentation.contains(.banner) { options.insert(.banner) }
        if presentation.contains(.list) { options.insert(.list) }
        if presentation.contains(.sound) { options.insert(.sound) }
        return options
    }

    /// A tap on a notification. The completion-handler form on purpose: with the `async` form the
    /// bridge called iOS's handler from a cooperative thread after the await, and UIKit's snapshot
    /// update behind it asserts the main thread (the crash on tapping a banner, M29). The handler
    /// runs on the main actor here, with or without a route.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let route = Self.route(in: response.notification.request.content.userInfo)
        let done = CompletionBox(completionHandler)
        Task { @MainActor in
            if let route, let url = URL(string: route) { self.open(url) }
            done.call()
        }
    }

    /// The deep link of a local notification ("route") or a remote push ("route" / "url").
    nonisolated private static func route(in userInfo: [AnyHashable: Any]) -> String? {
        (userInfo["route"] as? String) ?? (userInfo["url"] as? String)
    }
}

/// iOS's completion handler for a notification response, carried to the main actor. UIKit hands it
/// over unannotated (not @Sendable) and expects it called once, on the main thread, which is where
/// `call()` is used.
private struct CompletionBox: @unchecked Sendable {
    private let handler: () -> Void
    init(_ handler: @escaping () -> Void) { self.handler = handler }
    func call() { handler() }
}

// MARK: - App delegate

/// Remote push registration and the notification center delegate (set before launch finishes,
/// so a tap that launched the app is delivered).
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = NotificationsCoordinator.shared
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationsCoordinator.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        NotificationsCoordinator.shared.didFailToRegister(error)
    }

    /// M21: the silent push `{aps: {content-available: 1}, withdraw: ["approval-<id>"]}` the server
    /// sends when an approval was decided after its push went out: that push leaves Notification
    /// Center (needs UIBackgroundModes remote-notification; iOS doesn't wake an app the user
    /// force-quit). Other pushes have nothing to fetch here.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        let ids = NotificationRules.withdrawIds(in: userInfo)
        guard !ids.isEmpty else {
            completionHandler(.noData)
            return
        }
        Task {
            await NotificationsCoordinator.withdraw(ids)
            completionHandler(.newData)
        }
    }

    /// Portrait everywhere; the full-screen "OpenDuet's computer" view (L143) widens it while it
    /// is up, and (M27 W6) its full-screen button forces landscape (OrientationLock).
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        switch OrientationLock.mask {
        case .portrait: .portrait
        case .landscape: .landscape
        case .any: .allButUpsideDown
        }
    }
}

/// Set by the "OpenDuet's computer" view while it is on screen; turning it off rotates back to
/// portrait. M27 W6: the full-screen button turns the interface itself to landscape (a real
/// interface rotation, so the keyboard, safe areas, status bar and VoiceOver follow), held there
/// until ✕; ✕ turns back to portrait at once and holds it until the phone has been upright
/// (RotationRules). The phone's own orientation is watched only while the view is up.
@MainActor
enum OrientationLock {
    private static var rules = RotationRules()
    private static var observer: NSObjectProtocol?

    static var mask: RotationRules.Mask { rules.mask }

    static var allowLandscape: Bool {
        get { rules.allowsLandscape }
        set {
            guard newValue != rules.allowsLandscape else { return }
            if newValue { rules.open() } else { rules.close() }
            watchPhone(newValue)
            apply(rotateTo: newValue ? nil : .portrait)
        }
    }

    /// The full-screen button: landscape now, whichever way the phone is held.
    static func enterFullScreen() {
        rules.enterFullScreen()
        apply(rotateTo: landscapeSide())
    }

    /// ✕ or the escape gesture: portrait now.
    static func exitFullScreen() {
        rules.exitFullScreen(phoneUpright: !UIDevice.current.orientation.isLandscape)
        apply(rotateTo: .portrait)
    }

    /// The landscape the phone is in (its home side), else home on the right.
    private static func landscapeSide() -> UIInterfaceOrientationMask {
        switch UIDevice.current.orientation {
        case .landscapeRight: .landscapeLeft
        default: .landscapeRight
        }
    }

    private static func apply(rotateTo orientation: UIInterfaceOrientationMask?) {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            var controller = scene.keyWindow?.rootViewController
            while let current = controller {
                current.setNeedsUpdateOfSupportedInterfaceOrientations()
                controller = current.presentedViewController
            }
            if let orientation {
                scene.requestGeometryUpdate(UIWindowScene.GeometryPreferences.iOS(interfaceOrientations: orientation))
            }
        }
    }

    /// Ends the hold after ✕ once the phone has been upright.
    private static func watchPhone(_ on: Bool) {
        if on, observer == nil {
            UIDevice.current.beginGeneratingDeviceOrientationNotifications()
            observer = NotificationCenter.default.addObserver(forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { phoneTurned() }
            }
        } else if !on, let token = observer {
            NotificationCenter.default.removeObserver(token)
            observer = nil
            UIDevice.current.endGeneratingDeviceOrientationNotifications()
        }
    }

    private static func phoneTurned() {
        let before = rules.mask
        rules.phoneTurned(upright: UIDevice.current.orientation == .portrait)
        if rules.mask != before { apply(rotateTo: nil) }
    }
}

extension NotificationsCoordinator {
    /// profile > Notifications when they are off in iOS Settings.
    static func openSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

/// M29: NotificationRules' interruption as UserNotifications' level, and back (a push's
/// `interruption-level`; time-sensitive and critical count as active).
extension NotificationRules.Interruption {
    init(_ level: UNNotificationInterruptionLevel) {
        self = level == .passive ? .passive : .active
    }

    var level: UNNotificationInterruptionLevel {
        switch self {
        case .active: .active
        case .passive: .passive
        }
    }
}
