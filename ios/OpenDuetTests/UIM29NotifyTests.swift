// M29 notify: a `notification` event's `passive` (quiet hours) decodes leniently; a passive one
// is silent and goes to Notification Center only, in the foreground too (NotificationRules
// .Interruption / .presentation); the APNs environment follows the provisioning profile's
// aps-environment (NotificationRules.apnsEnvironment); the app icon badge is the Waiting on you
// count, 0 when signed out.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M29 notify: quiet hours")
struct UIM29NotifyQuietTests {
    private func notification(_ extra: [String: Any]) -> DuetEvent.Notification? {
        let phrase: [String: Any] = ["key": "notify.title", "params": NSNull(), "text": NSNull()]
        var payload: [String: Any] = ["title": phrase, "body": ["text": "Hi"], "route": "duet://tasks/t1", "collapseId": "task-t1"]
        payload.merge(extra) { _, new in new }
        guard case .notification(let n) = Fx.event(9, "notification", payload).body else { return nil }
        return n
    }

    @Test("passive decodes; missing, null or the wrong type is false and keeps the event")
    func decoding() {
        #expect(notification(["passive": true])?.passive == true)
        #expect(notification(["passive": false])?.passive == false)
        #expect(notification([:])?.passive == false, "servers from before M29")
        #expect(notification(["passive": NSNull()])?.passive == false)
        #expect(notification(["passive": "true"])?.passive == false, "a wrong type doesn't drop the event")
        #expect(notification(["passive": ["on": true]])?.passive == false)
        let odd = notification(["passive": "yes"])
        #expect(odd?.collapseId == "task-t1")
        #expect(odd?.route == "duet://tasks/t1")
    }

    @Test("A passive local notification has no sound; the rest play the default sound")
    func sound() {
        #expect(NotificationRules.Interruption(passive: true) == .passive)
        #expect(NotificationRules.Interruption(passive: false) == .active)
        #expect(!NotificationRules.Interruption.passive.playsSound)
        #expect(NotificationRules.Interruption.active.playsSound)
    }

    @Test("willPresent: a passive one only goes to Notification Center; nothing when it shouldn't show")
    func presentation() {
        #expect(NotificationRules.presentation(show: true, .active) == [.banner, .list, .sound])
        #expect(NotificationRules.presentation(show: true, .passive) == [.list], "no banner, no sound")
        #expect(NotificationRules.presentation(show: false, .active).isEmpty)
        #expect(NotificationRules.presentation(show: false, .passive).isEmpty)
    }
}

@Suite("M29 notify: APNs environment")
struct UIM29NotifyEnvironmentTests {
    /// A provisioning profile as iOS embeds it: an XML plist inside a CMS envelope (binary bytes
    /// before and after).
    private func profile(_ entitlements: [String: Any]) throws -> Data {
        let plist: [String: Any] = [
            "AppIDName": "OpenDuet",
            "Entitlements": entitlements,
            "Name": "iOS Team Provisioning Profile: dev.openduet.OpenDuet",
            "TeamIdentifier": ["A1B2C3D4E5"],
        ]
        let xml = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        return Data([0x30, 0x82, 0x2F, 0x1A, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02, 0xA0])
            + xml
            + Data([0xA0, 0x82, 0x0D, 0x3E, 0x30, 0x82, 0x04, 0x34, 0x00, 0xFF])
    }

    @Test("aps-environment is read from the plist inside the profile")
    func parses() throws {
        let development = try profile(["aps-environment": "development", "get-task-allow": true])
        #expect(NotificationRules.apsEnvironment(profile: development) == "development")
        let production = try profile(["aps-environment": "production", "get-task-allow": false])
        #expect(NotificationRules.apsEnvironment(profile: production) == "production")
    }

    @Test("No aps-environment (a free account's profile), or a profile that can't be read: nil")
    func missingOrUnreadable() throws {
        #expect(NotificationRules.apsEnvironment(profile: try profile(["get-task-allow": true])) == nil)
        #expect(NotificationRules.apsEnvironment(profile: try profile(["aps-environment": 1])) == nil)
        #expect(NotificationRules.apsEnvironment(profile: Data()) == nil)
        #expect(NotificationRules.apsEnvironment(profile: Data([0x30, 0x82, 0x00, 0xFF, 0x13])) == nil)
        let full = try profile(["aps-environment": "development"])
        #expect(NotificationRules.apsEnvironment(profile: full.prefix(full.count / 2)) == nil, "cut off before </plist>")
        let broken = Data("<?xml version=\"1.0\"?><plist><dict><key>Entitlements</key></plist>".utf8)
        #expect(NotificationRules.apsEnvironment(profile: broken) == nil)
    }

    @Test("development = sandbox, production = production, whatever the build configuration")
    func environment() throws {
        let development = try profile(["aps-environment": "development"])
        let production = try profile(["aps-environment": "production"])
        #expect(NotificationRules.apnsEnvironment(profile: development, debugBuild: false) == .sandbox, "a Release build signed for development")
        #expect(NotificationRules.apnsEnvironment(profile: development, debugBuild: true) == .sandbox)
        #expect(NotificationRules.apnsEnvironment(profile: production, debugBuild: true) == .production)
        #expect(NotificationRules.apnsEnvironment(profile: production, debugBuild: false) == .production)
    }

    @Test("No profile (App Store, TestFlight) is production; an unreadable one falls back to the build")
    func fallbacks() throws {
        #expect(NotificationRules.apnsEnvironment(profile: nil, debugBuild: true) == .production)
        #expect(NotificationRules.apnsEnvironment(profile: nil, debugBuild: false) == .production)
        #expect(NotificationRules.apnsEnvironment(profile: Data(), debugBuild: true) == .sandbox)
        #expect(NotificationRules.apnsEnvironment(profile: Data(), debugBuild: false) == .production)
        let noKey = try profile(["get-task-allow": true])
        #expect(NotificationRules.apnsEnvironment(profile: noKey, debugBuild: true) == .sandbox)
        #expect(NotificationRules.apnsEnvironment(profile: noKey, debugBuild: false) == .production)
        let odd = try profile(["aps-environment": "staging"])
        #expect(NotificationRules.apnsEnvironment(profile: odd, debugBuild: false) == .production)
    }
}

@Suite("M29 notify: app icon badge")
struct UIM29NotifyBadgeTests {
    @Test("The icon shows the Waiting on you count while signed in")
    func signedIn() {
        #expect(NotificationRules.appBadge(waitingOnYou: 3, signedIn: true) == 3)
        #expect(NotificationRules.appBadge(waitingOnYou: 0, signedIn: true) == 0, "nothing waiting: no badge")
        #expect(NotificationRules.appBadge(waitingOnYou: -2, signedIn: true) == 0)
    }

    @Test("Signed out: no badge")
    func signedOut() {
        #expect(NotificationRules.appBadge(waitingOnYou: 5, signedIn: false) == 0)
        #expect(NotificationRules.appBadge(waitingOnYou: 0, signedIn: false) == 0)
    }

    @Test("The count is the Tasks tab's: GET /api/needs-you less what was settled here since")
    func sameAsTasksTab() {
        var list = TasksReducer()
        list.applyNeedsYou(NeedsYou(count: 2, items: [.task(Fx.task("n", status: "needs_input")), .unsupported(kind: "x")]))
        #expect(NotificationRules.appBadge(waitingOnYou: list.needingUser, signedIn: true) == 2)
    }
}
