// M28 auth: the model name for X-Device-Name (the table, the simulator, unknown identifiers, the
// header rule applied), RequestContext.apply sending it on every request (sign-in included), what a
// failed load / sign-out / sign-out-others means (404 on the list = an older server, 404 on a
// sign-out = gone, 400 on `id` = reload, another code = the reason), and the live computer's
// socket-close rule (4001 / a 401 upgrade: no retry, one check; 1011 / the network: backoff).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M28 device name and errors")
struct DataM28AuthTests {
    // MARK: - DeviceModelName

    @Test("Known identifiers read their model name")
    func knownIdentifiers() {
        #expect(DeviceModelName.name(machine: "iPhone17,1", simulatorModel: nil, idiomIsPad: false) == "iPhone 16 Pro")
        #expect(DeviceModelName.name(machine: "iPhone11,2", simulatorModel: nil, idiomIsPad: false) == "iPhone XS")
        #expect(DeviceModelName.name(machine: "iPhone12,8", simulatorModel: nil, idiomIsPad: false) == "iPhone SE (2nd generation)")
        #expect(DeviceModelName.name(machine: "iPhone17,5", simulatorModel: nil, idiomIsPad: false) == "iPhone 16e")
        #expect(DeviceModelName.name(machine: "iPad14,8", simulatorModel: nil, idiomIsPad: false) == "iPad Air")
        #expect(DeviceModelName.name(machine: "iPad16,1", simulatorModel: nil, idiomIsPad: false) == "iPad mini")
        #expect(DeviceModelName.name(machine: "iPad8,1", simulatorModel: nil, idiomIsPad: false) == "iPad Pro")
        #expect(DeviceModelName.name(machine: "iPad13,18", simulatorModel: nil, idiomIsPad: false) == "iPad")
    }

    @Test("Every iPhone from the XS on is in the table")
    func everyIPhone() {
        let names = Set(DeviceModelName.table.values)
        let wanted = [
            "iPhone XS", "iPhone XS Max", "iPhone XR", "iPhone 11", "iPhone 11 Pro", "iPhone 11 Pro Max",
            "iPhone SE (2nd generation)", "iPhone 12 mini", "iPhone 12", "iPhone 12 Pro", "iPhone 12 Pro Max",
            "iPhone 13 mini", "iPhone 13", "iPhone 13 Pro", "iPhone 13 Pro Max", "iPhone SE (3rd generation)",
            "iPhone 14", "iPhone 14 Plus", "iPhone 14 Pro", "iPhone 14 Pro Max",
            "iPhone 15", "iPhone 15 Plus", "iPhone 15 Pro", "iPhone 15 Pro Max",
            "iPhone 16", "iPhone 16 Plus", "iPhone 16 Pro", "iPhone 16 Pro Max", "iPhone 16e",
        ]
        for name in wanted { #expect(names.contains(name), "\(name)") }
        #expect(names.isSuperset(of: ["iPad", "iPad mini", "iPad Air", "iPad Pro"]))
    }

    @Test("The simulator reads the simulated device's identifier")
    func simulator() {
        #expect(DeviceModelName.name(machine: "arm64", simulatorModel: "iPhone16,2", idiomIsPad: false) == "iPhone 15 Pro Max")
        #expect(DeviceModelName.name(machine: "x86_64", simulatorModel: "iPad14,8", idiomIsPad: true) == "iPad Air")
        #expect(DeviceModelName.identifier(machine: "arm64", simulatorModel: nil) == nil)
        #expect(DeviceModelName.identifier(machine: "arm64", simulatorModel: " ") == nil)
        #expect(DeviceModelName.identifier(machine: "iPhone17,1", simulatorModel: "iPad14,8") == "iPhone17,1")
    }

    @Test("Unknown identifiers read iPhone / iPad by their prefix, else by the idiom")
    func unknownIdentifiers() {
        #expect(DeviceModelName.name(machine: "iPhone99,9", simulatorModel: nil, idiomIsPad: true) == "iPhone")
        #expect(DeviceModelName.name(machine: "iPad99,1", simulatorModel: nil, idiomIsPad: false) == "iPad")
        #expect(DeviceModelName.name(machine: "Mac14,2", simulatorModel: nil, idiomIsPad: false) == "iPhone")
        #expect(DeviceModelName.name(machine: "Mac14,2", simulatorModel: nil, idiomIsPad: true) == "iPad")
        #expect(DeviceModelName.name(machine: "arm64", simulatorModel: nil, idiomIsPad: true) == "iPad")
        #expect(DeviceModelName.name(machine: nil, simulatorModel: nil, idiomIsPad: false) == "iPhone")
        #expect(DeviceModelName.name(machine: "", simulatorModel: nil, idiomIsPad: false) == "iPhone")
    }

    @Test("Every name passes the X-Device-Name rule unchanged")
    func headerRule() {
        for name in Array(Set(DeviceModelName.table.values)) + ["iPhone", "iPad"] {
            #expect(DeviceNameHeader.header(name) == name, "\(name)")
        }
        #expect(DeviceNameHeader.header(DeviceModelName.current) == DeviceModelName.current)
        // The rule itself refuses what the table never holds: no header then.
        #expect(DeviceNameHeader.header("Sam’s iPhone") == nil)
        #expect(DeviceNameHeader.header("   ") == nil)
    }

    @Test("iPad names are told apart")
    func iPadNames() {
        #expect(DeviceModelName.isIPad("iPad Air") && DeviceModelName.isIPad("iPad"))
        #expect(!DeviceModelName.isIPad("iPhone 16 Pro") && !DeviceModelName.isIPad(nil))
    }

    // MARK: - RequestContext

    @Test("RequestContext.apply sends X-Device-Name with the other headers, signed in or not")
    func requestHeaders() throws {
        let url = try #require(URL(string: "https://duet.example.com/api/me"))
        var signedIn = URLRequest(url: url)
        RequestContext.apply(to: &signedIn, token: "tok")
        #expect(RequestContext.deviceName == DeviceNameHeader.header(DeviceModelName.current))
        #expect(RequestContext.deviceName != nil)
        #expect(signedIn.value(forHTTPHeaderField: DeviceNameHeader.field) == RequestContext.deviceName)
        #expect(signedIn.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(signedIn.value(forHTTPHeaderField: "X-Timezone") == RequestContext.timezone)
        #expect(signedIn.value(forHTTPHeaderField: "X-Locale") == RequestContext.locale.rawValue)

        var signIn = URLRequest(url: url)
        RequestContext.apply(to: &signIn, token: nil)
        #expect(signIn.value(forHTTPHeaderField: "X-Device-Name") == RequestContext.deviceName)
        #expect(signIn.value(forHTTPHeaderField: "Authorization") == nil)
    }

    // MARK: - Errors

    private func apiError(_ status: Int, _ json: String) -> APIError {
        APIError(status: status, body: Data(json.utf8))
    }

    @Test("A failed list: 404 = an older server, cancelled = nothing, else the reason")
    func loadFailures() {
        #expect(DevicesRules.loadFailure(apiError(404, #"{"error":{"code":"not_found","message":"Not found."}}"#)) == .olderServer)
        #expect(DevicesRules.loadFailure(apiError(404, "<html>")) == .olderServer)
        #expect(DevicesRules.loadFailure(CancellationError()) == .ignore)
        #expect(DevicesRules.loadFailure(APIError.unreachable) == .reason("Can't reach your server."))
        #expect(DevicesRules.loadFailure(APIError.server(status: 500, code: "internal")) == .reason("Something went wrong."))
        #expect(DevicesRules.loadFailure(APIError.unauthorized) == .reason("Sign in again."))
    }

    @Test("A sign-out: 204 / 404 = gone, 400 on id = reload, cancelled = nothing, else the reason")
    func deleteOutcomes() {
        #expect(DevicesRules.deleteOutcome(nil) == .gone)
        #expect(DevicesRules.deleteOutcome(apiError(404, #"{"error":{"code":"not_found","message":"Not found."}}"#)) == .gone)
        let current = #"{"error":{"code":"validation_failed","message":"id: this is the session making the request; use sign out","field":"id"}}"#
        #expect(DevicesRules.deleteOutcome(apiError(400, current)) == .reload)
        #expect(DevicesRules.deleteOutcome(APIError.validationFailed(field: "name", message: "name: too long")) == .failed("name: too long"))
        #expect(DevicesRules.deleteOutcome(CancellationError()) == .ignore)
        #expect(DevicesRules.deleteOutcome(APIError.unreachable) == .failed("Can't reach your server."))
        #expect(DevicesRules.deleteOutcome(APIError.rateLimited) == .failed("Too many attempts. Try again in a moment."))
    }

    @Test("Sign out other devices: the result line and the refusal")
    func revokeLines() {
        #expect(DevicesRules.revokedLine(0) == nil)
        #expect(DevicesRules.revokedLine(-1) == nil)
        #expect(DevicesRules.revokedLine(1) == "Signed out 1 device")
        #expect(DevicesRules.revokedLine(3) == "Signed out 3 devices")
        #expect(DevicesRules.revokeFailure(APIError.unreachable) == "Can't reach your server.")
        #expect(DevicesRules.revokeFailure(CancellationError()) == nil)
    }

    // MARK: - The live computer's socket

    @Test("4001 or a 401 upgrade: no retry, one check; 1011 / the network: backoff")
    func computerStreamClose() {
        #expect(ComputerStreamEnd.after(closeCode: 4001, upgradeStatus: 101) == .checkSession)
        #expect(ComputerStreamEnd.after(closeCode: 0, upgradeStatus: 401) == .checkSession)
        #expect(ComputerStreamEnd.after(closeCode: 1011, upgradeStatus: 101) == .retry)
        #expect(ComputerStreamEnd.after(closeCode: 1006, upgradeStatus: nil) == .retry)
        #expect(ComputerStreamEnd.after(closeCode: 0, upgradeStatus: nil) == .retry)
        #expect(ComputerStreamEnd.after(closeCode: 1000, upgradeStatus: 502) == .retry)
        // After the check: its 401 ends the stream; a good session or no answer goes back to backoff.
        #expect(!ComputerStreamEnd.reconnects(afterCheckRefused: true))
        #expect(ComputerStreamEnd.reconnects(afterCheckRefused: false))
    }
}
