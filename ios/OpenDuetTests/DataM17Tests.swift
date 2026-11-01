// M17 data and rules (docs/API.md "M17"): the m17 samples decode (requests re-encode to the same
// JSON), older connectors without `registryName` / `oauth` still decode, the sign-in callback URL
// becomes an OAuthFinishRequest, the install sheet's input rules, a template row's hint and Add /
// Added state, the gallery's pages, the server's words for a failed request and the skip reasons.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private func object(_ value: some Encodable) throws -> [String: Any] {
    let data = try JSONCoding.encoder().encode(value)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

/// The request samples of m17.json re-encode to exactly the same JSON.
private func roundTrips<T: Codable>(_ type: T.Type, _ shape: String) throws -> Int {
    let value = try #require(try M9Samples.json("m17")[shape], "no \(shape) in m17.json")
    let items = (value as? [Any]) ?? [value]
    for item in items {
        let original = try JSONSerialization.data(withJSONObject: item)
        let decoded = try JSONCoding.decoder().decode(T.self, from: original)
        let again = try #require(try JSONSerialization.jsonObject(with: JSONCoding.encoder().encode(decoded)) as? NSObject)
        let expected = try #require(try JSONSerialization.jsonObject(with: original) as? NSObject)
        let same = expected.isEqual(again)
        #expect(same, "\(shape) re-encoded differently")
    }
    return items.count
}

private func template(
    _ name: String = "app.linear/linear", inputs: [ConnectorTemplateInput] = [], needsSignIn: Bool? = nil,
    installed: Bool = false, featured: Bool = false
) -> ConnectorTemplate {
    ConnectorTemplate(
        name: name, title: "Linear", description: "Issues", website: nil, iconUrl: nil,
        remote: .init(type: .streamableHTTP, url: "https://mcp.linear.app/mcp"), inputs: inputs,
        needsSignIn: needsSignIn, installed: installed, featured: featured
    )
}

private func input(_ name: String, kind: ConnectorTemplateInput.Kind = .header, secret: Bool = false, required: Bool = true) -> ConnectorTemplateInput {
    ConnectorTemplateInput(name: name, description: "", secret: secret, required: required, kind: kind)
}

private func failure(_ status: Int, code: String, message: String, field: String? = nil) -> ServerFailure {
    var detail: [String: Any] = ["code": code, "message": message]
    if let field { detail["field"] = field }
    let body = try! JSONSerialization.data(withJSONObject: ["error": detail])
    return ServerFailure(status: status, body: body)
}

@Suite("M17 samples")
struct DataM17SampleTests {
    @Test("every m17 shape decodes; requests re-encode exactly (empty inputs and nil left out)")
    func samplesDecode() throws {
        let lists = try M9Samples.decode(ConnectorTemplateList.self, "m17", "ConnectorTemplateList")
        let first = try #require(lists.first)
        #expect(first.templates.count == 6)
        #expect(first.nextCursor == "com.example/events:1.0.0")
        #expect(lists.last?.nextCursor == nil)
        let github = try #require(first.templates.first { $0.title == "GitHub" })
        #expect(github.inputs.first?.kind == .header && github.inputs.first?.secret == true)
        #expect(github.needsSignIn == nil)
        #expect(first.templates.first { $0.title == "Events" }?.remote.type == .sse)
        #expect(first.templates.first { $0.title == "Example Tenant" }?.inputs.map(\.kind) == [.urlVariable, .header])

        let installs = try M9Samples.decode(InstallTemplateResponse.self, "m17", "InstallTemplateResponse")
        #expect(installs.map(\.needsSignIn) == [true, false, false])
        #expect(installs[0].connector.needsSignIn && installs[0].connector.status == .failed)
        #expect(installs[0].connector.registryName == "app.linear/linear")

        let start = try #require(try M9Samples.decode(OAuthStartResponse.self, "m17", "OAuthStartResponse").first)
        #expect(start.callbackScheme == OAuthCallback.scheme)
        #expect(start.redirectUri == "duet://oauth/callback")
        #expect(URL(string: start.authorizeUrl)?.scheme == "https")

        let imported = try #require(try M9Samples.decode(ImportConnectorsResponse.self, "m17", "ImportConnectorsResponse").first)
        #expect(imported.connectors.map(\.name) == ["linear", "my-api"])
        #expect(imported.skipped.map(\.reason) == [.stdio, .exists, .invalid, .failed])

        let responses = try M9Samples.decode(CustomConnectorResponse.self, "m17", "CustomConnectorResponse")
        let signedIn = try #require(responses.first?.connector)
        #expect(signedIn.isSignedIn && !signedIn.needsSignIn)
        #expect(signedIn.oauth?.expiresAt == JSONCoding.parseDate("2026-12-13T10:00:00Z"))

        #expect(try roundTrips(InstallTemplateRequest.self, "InstallTemplateRequest") == 2)
        #expect(try roundTrips(OAuthFinishRequest.self, "OAuthFinishRequest") == 2)
        #expect(try roundTrips(ImportConnectorsRequest.self, "ImportConnectorsRequest") == 1)
    }

    @Test("an older server's connector (no registryName, no oauth) decodes as before")
    func olderConnector() throws {
        let old = try #require(try M9Samples.decode(CustomConnectorList.self, "m11", "CustomConnectorList").first?.connectors.first)
        #expect(old.registryName == nil)
        #expect(old.oauth == nil)
        #expect(!old.needsSignIn && !old.isSignedIn)
    }

    @Test("a skip reason the app doesn't know yet decodes as .other")
    func unknownSkipReason() throws {
        let json = #"{"connectors":[],"skipped":[{"name":"x","reason":"quota","message":"Too many connectors."}]}"#
        let response = try JSONCoding.decoder().decode(ImportConnectorsResponse.self, from: Data(json.utf8))
        #expect(response.skipped.first?.reason == .other("quota"))
        #expect(ImportCopy.reason(response.skipped[0]) == "Too many connectors.")
    }

    @Test("a one-tap install sends only the name")
    func oneTapBody() throws {
        let body = try object(InstallTemplateRequest(name: "app.linear/linear"))
        #expect(body.keys.sorted() == ["name"])
        let filled = try object(InstallTemplateRequest(name: "x", inputs: ["Authorization": "t"]))
        #expect((filled["inputs"] as? [String: String]) == ["Authorization": "t"])
    }
}

@Suite("M17 sign-in callback")
struct DataM17CallbackTests {
    @Test("code and state become the finish request; nothing else is sent")
    func success() throws {
        let url = try #require(URL(string: "duet://oauth/callback?code=c%2Fd%3D1&state=st_1&iss=https%3A%2F%2Fauth.example"))
        let body = try #require(OAuthCallback.finishRequest(from: url))
        #expect(body == OAuthFinishRequest(state: "st_1", code: "c/d=1"))
        let json = try object(body)
        #expect(json.keys.sorted() == ["code", "state"])
    }

    @Test("an error with its description; the code is dropped next to an error")
    func error() throws {
        let url = try #require(URL(string: "duet://oauth/callback?error=access_denied&error_description=User%20said%20no&state=st_2&code=zzz"))
        let body = try #require(OAuthCallback.finishRequest(from: url))
        #expect(body.state == "st_2")
        #expect(body.code == nil)
        #expect(body.error == "access_denied")
        #expect(body.errorDescription == "User said no")
        #expect(try object(body).keys.sorted() == ["error", "errorDescription", "state"])
    }

    @Test("no state, another route or another path: nothing to finish")
    func notACallback() throws {
        #expect(OAuthCallback.finishRequest(from: URL(string: "duet://oauth/callback?code=x")!) == nil)
        #expect(OAuthCallback.finishRequest(from: URL(string: "duet://channels/c1?state=s&code=x")!) == nil)
        #expect(OAuthCallback.finishRequest(from: URL(string: "duet://oauth/other?state=s&code=x")!) == nil)
        #expect(OAuthCallback.finishRequest(from: URL(string: "https://oauth/callback?state=s&code=x")!) == nil)
        let slash = OAuthCallback.finishRequest(from: URL(string: "duet://oauth/callback/?state=s&code=x")!)
        #expect(slash == OAuthFinishRequest(state: "s", code: "x"))
    }

    @Test("state alone: an error the server turns into \"didn't finish\"; long descriptions are cut")
    func stateOnly() throws {
        let body = try #require(OAuthCallback.finishRequest(from: URL(string: "duet://oauth/callback?state=s")!))
        #expect(body.code == nil)
        #expect(body.error == "invalid_request")
        let long = String(repeating: "a", count: 1500)
        let cut = try #require(OAuthCallback.finishRequest(from: URL(string: "duet://oauth/callback?state=s&error=x&error_description=\(long)")!))
        #expect(cut.errorDescription?.count == 1000)
    }

    @Test("the link router ignores duet://oauth (no route), other duet links still route")
    func routerIgnoresCallback() throws {
        let callback = try #require(URL(string: "duet://oauth/callback?code=x&state=y"))
        #expect(OAuthCallback.isCallback(callback))
        #expect(OAuthCallback.isCallback(URL(string: "DUET://OAUTH/callback")!))
        #expect(DuetRoute(callback) == nil)
        #expect(!OAuthCallback.isCallback(URL(string: "duet://channels/c1")!))
        #expect(DuetRoute(URL(string: "duet://channels/c1")!) == .channel(id: "c1"))
    }

    @Test("after a sign-in: cancel and success go back to idle, a failure keeps its reason")
    func phases() {
        #expect(SignInPhase.after(.cancelled) == .idle)
        let failed = SignInPhase.after(.failed(reason: "This sign-in expired. Try again.", expired: true))
        #expect(failed.failure == "This sign-in expired. Try again.")
        #expect(failed.expired)
        #expect(!failed.isRunning)
        #expect(SignInPhase.running.isRunning)
        #expect(SignInPhase.idle.failure == nil)
    }
}

@Suite("M17 template inputs and rows")
struct DataM17TemplateTests {
    @Test("only required inputs are asked; none required = one tap")
    func asked() {
        let tenant = template(inputs: [input("tenant", kind: .urlVariable), input("X-Region", required: false)])
        #expect(TemplateInputRules.asked(tenant).map(\.name) == ["tenant"])
        #expect(!TemplateInputRules.isOneTap(tenant))
        #expect(TemplateInputRules.isOneTap(template(inputs: [input("X-Region", required: false)])))
        #expect(TemplateInputRules.isOneTap(template()))
    }

    @Test("a URL part is one segment; a header value is one line")
    func problems() {
        let segment = input("tenant", kind: .urlVariable)
        #expect(TemplateInputRules.problem(segment, "acme-1.eu_x~") == nil)
        #expect(TemplateInputRules.problem(segment, "  acme  ") == nil)
        #expect(TemplateInputRules.problem(segment, "") == nil)
        for bad in ["a/b", "a?b", "a#b", "a@b", "a b", "{x}"] {
            #expect(TemplateInputRules.problem(segment, bad) == .segment, "\(bad)")
        }
        #expect(TemplateInputRules.problem(segment, String(repeating: "a", count: 201)) == .tooLong)
        let header = input("Authorization", secret: true)
        #expect(TemplateInputRules.problem(header, "ghp_abc def") == nil)
        #expect(TemplateInputRules.problem(header, "a\nb") == .multiline)
        #expect(TemplateInputRules.problem(header, String(repeating: "a", count: 4001)) == .tooLong)
    }

    @Test("the request carries the asked values trimmed; nil while one is empty or wrong")
    func request() {
        let github = template("io.github.github/github-mcp-server", inputs: [input("Authorization", secret: true), input("X-Opt", required: false)])
        #expect(TemplateInputRules.request(github, values: [:]) == nil)
        #expect(TemplateInputRules.request(github, values: ["Authorization": "   "]) == nil)
        let body = TemplateInputRules.request(github, values: ["Authorization": "  ghp_1 ", "X-Opt": "ignored"])
        #expect(body == InstallTemplateRequest(name: "io.github.github/github-mcp-server", inputs: ["Authorization": "ghp_1"]))
        let tenant = template(inputs: [input("tenant", kind: .urlVariable)])
        #expect(TemplateInputRules.request(tenant, values: ["tenant": "a/b"]) == nil)
    }

    @Test("hints: only what the server learned")
    func hints() {
        #expect(TemplateHint.of(template(needsSignIn: true)) == .signsIn)
        #expect(TemplateHint.of(template(inputs: [input("Authorization")], needsSignIn: true)) == .signsIn)
        #expect(TemplateHint.of(template(needsSignIn: false)) == .nothingToFill)
        #expect(TemplateHint.of(template(inputs: [input("X", required: false)], needsSignIn: false)) == nil)
        #expect(TemplateHint.of(template(needsSignIn: nil)) == nil)
        #expect(String(localized: TemplateHint.signsIn.text) == "Signs in")
        #expect(String(localized: TemplateHint.nothingToFill.text) == "Nothing to fill in")
    }

    @Test("Add / Added: the loaded connector list wins over the template's flag")
    func rowState() throws {
        let page = try #require(try M9Samples.decode(InstallTemplateResponse.self, "m17", "InstallTemplateResponse").first?.connector)
        let linear = template(installed: true)
        #expect(TemplateRowState.of(linear, connectors: nil, installing: nil) == .added(connectorId: nil))
        #expect(TemplateRowState.of(template(), connectors: nil, installing: nil) == .add)
        #expect(TemplateRowState.of(linear, connectors: [page], installing: nil) == .added(connectorId: "cc_lin"))
        // Deleted since the page loaded: back to Add.
        #expect(TemplateRowState.of(linear, connectors: [], installing: nil) == .add)
        // Added from another device, the list knows it: Added.
        #expect(TemplateRowState.of(template(), connectors: [page], installing: nil) == .added(connectorId: "cc_lin"))
        #expect(TemplateRowState.of(linear, connectors: [page], installing: "app.linear/linear") == .installing)
        #expect(TemplateRowState.of(linear, connectors: [page], installing: "other") == .added(connectorId: "cc_lin"))
    }
}

@Suite("M17 gallery pages")
struct DataM17GalleryTests {
    private func list(_ names: [String], featured: Set<String> = [], next: String? = nil) -> ConnectorTemplateList {
        ConnectorTemplateList(templates: names.map { template($0, featured: featured.contains($0)) }, nextCursor: next)
    }

    @Test("first page: featured in the server's order, then the rest; each template once")
    func firstPage() {
        var gallery = TemplateGallery()
        let generation = gallery.begin(query: "")
        #expect(gallery.phase == .loading)
        gallery.received(list(["linear", "notion", "a", "linear", "b"], featured: ["linear", "notion"], next: "c1"), generation: generation)
        #expect(gallery.phase == .loaded)
        #expect(gallery.featured.map(\.name) == ["linear", "notion"])
        #expect(gallery.rest.map(\.name) == ["a", "b"])
        #expect(gallery.hasMore)
        #expect(!gallery.isEmptySearch)
    }

    @Test("more pages append without repeats; the end stops paging")
    func paging() throws {
        var gallery = TemplateGallery()
        let generation = gallery.begin(query: "")
        gallery.received(list(["a", "b"], next: "c1"), generation: generation)
        let started = gallery.beginMore()
        let next = try #require(started)
        #expect(next.cursor == "c1")
        #expect(gallery.loadingMore)
        let twice = gallery.beginMore()
        #expect(twice == nil)
        gallery.receivedMore(list(["b", "c"], next: nil), generation: next.generation)
        #expect(gallery.templates.map(\.name) == ["a", "b", "c"])
        #expect(!gallery.loadingMore)
        let atEnd = gallery.beginMore()
        #expect(atEnd == nil)
    }

    @Test("a failed page keeps the rows and offers Retry; a failed first page shows the reason")
    func failures() throws {
        var gallery = TemplateGallery()
        var generation = gallery.begin(query: "")
        gallery.received(list(["a"], next: "c1"), generation: generation)
        let started = gallery.beginMore()
        let next = try #require(started)
        gallery.failedMore("Can't reach your server.", generation: next.generation)
        #expect(gallery.moreFailure == "Can't reach your server.")
        #expect(gallery.templates.map(\.name) == ["a"])
        let retry = gallery.beginMore()
        #expect(retry?.cursor == "c1")

        generation = gallery.begin(query: "")
        gallery.failed("The MCP Registry couldn't be reached. Try again in a moment.", generation: generation)
        #expect(gallery.phase == .failed("The MCP Registry couldn't be reached. Try again in a moment."))
        #expect(gallery.templates.isEmpty)
        let afterFailure = gallery.beginMore()
        #expect(afterFailure == nil)
    }

    @Test("a newer query wins: older answers are dropped; the old rows stay while it searches")
    func staleAnswers() {
        var gallery = TemplateGallery()
        let first = gallery.begin(query: "")
        gallery.received(list(["a", "b"]), generation: first)
        let notion = gallery.begin(query: "  notion ")
        #expect(gallery.query == "notion")
        #expect(gallery.searching)
        #expect(gallery.phase == .loaded)
        let newer = gallery.begin(query: "linear")
        gallery.received(list(["notion"]), generation: notion)
        #expect(gallery.templates.map(\.name) == ["a", "b"])
        gallery.received(list([]), generation: newer)
        #expect(!gallery.searching)
        #expect(gallery.isEmptySearch)
        #expect(TemplateGallery.cleanQuery(String(repeating: "x", count: 150)).count == 100)
    }

    @Test("an install teaches the row whether it signs in")
    func learned() {
        var gallery = TemplateGallery()
        let generation = gallery.begin(query: "")
        gallery.received(list(["a"]), generation: generation)
        gallery.learned("a", needsSignIn: true)
        #expect(gallery.templates.first?.needsSignIn == true)
        #expect(gallery.templates.first?.installed == true)
        gallery.learned("missing", needsSignIn: false)
        #expect(gallery.templates.count == 1)
    }
}

@Suite("M17 reasons and copy")
struct DataM17ReasonTests {
    @Test("the server's own words for 400 / 404 / 409 / 502; the app's line for 401 and transport")
    func lines() {
        let missing = failure(400, code: "validation_failed", message: "inputs.token: required (missing: token)", field: "inputs.token")
        #expect(M17Reason.line(for: missing) == "inputs.token: required (missing: token)")
        #expect(M17Reason.fieldLine(for: missing) == "Required (missing: token)")
        #expect(M17Reason.inputName(missing) == "token")
        #expect(M17Reason.field(missing) == "inputs.token")

        let conflict = failure(409, code: "conflict", message: "Linear is installed already; change its settings on the connector.", field: "name")
        #expect(M17Reason.line(for: conflict) == "Linear is installed already; change its settings on the connector.")
        #expect(M17Reason.field(conflict) == nil)
        #expect(M17Reason.inputName(conflict) == nil)

        let registry = failure(502, code: "internal", message: "The MCP Registry couldn't be reached. Try again in a moment.")
        #expect(M17Reason.line(for: registry) == "The MCP Registry couldn't be reached. Try again in a moment.")
        let missingTemplate = failure(404, code: "not_found", message: "That connector isn't in the MCP Registry (or has no hosted version).", field: "name")
        #expect(M17Reason.line(for: missingTemplate)?.hasPrefix("That connector isn't") == true)

        let signedOut = failure(401, code: "unauthorized", message: "Sign in")
        #expect(M17Reason.line(for: signedOut) == APIError.unauthorized.localizedReason)
        #expect(M17Reason.line(for: APIError.unreachable) == APIError.unreachable.localizedReason)
        #expect(M17Reason.line(for: CancellationError()) == nil)
        #expect(M17Reason.line(for: ServerFailure(status: 500, body: Data("<html>".utf8))) == APIError.server(status: 500, code: "internal").localizedReason)
    }

    @Test("410 is an expired sign-in; json and code fields are found")
    func fields() {
        let expired = failure(410, code: "expired", message: "This sign-in expired or was already used. Start it again.", field: "state")
        #expect(M17Reason.isExpired(expired))
        #expect(M17Reason.field(expired) == nil)
        #expect(!M17Reason.isExpired(failure(400, code: "validation_failed", message: "code: Sign-in was cancelled.", field: "code")))
        let json = failure(400, code: "validation_failed", message: "json: that isn't JSON", field: "json")
        #expect(M17Reason.field(json) == "json")
        #expect(M17Reason.fieldLine(for: json) == "That isn't JSON")
        let plain = APIError.validationFailed(field: "json", message: "json: no MCP servers in that config")
        #expect(M17Reason.field(plain) == "json")
        #expect(M17Reason.fieldLine(for: plain) == "No MCP servers in that config")
    }

    @Test("skip reasons: the app's words for stdio and exists, the server's message otherwise")
    func skipReasons() throws {
        let skipped = try #require(try M9Samples.decode(ImportConnectorsResponse.self, "m17", "ImportConnectorsResponse").first?.skipped)
        #expect(ImportCopy.reasonKey(.stdio).map { String(localized: $0) } == "Runs a program on your computer; a hosted server can't run it")
        #expect(ImportCopy.reasonKey(.exists).map { String(localized: $0) } == "You have a connector with this address already")
        #expect(ImportCopy.reasonKey(.invalid) == nil)
        #expect(ImportCopy.reasonKey(.failed) == nil)
        #expect(ImportCopy.reasonKey(.other("x")) == nil)
        #expect(ImportCopy.reason(skipped[0]) == "Runs a program on your computer; a hosted server can't run it")
        #expect(ImportCopy.reason(skipped[2]) == "url: Only https addresses on a public host name work.")
        #expect(ImportCopy.reason(skipped[3]) == "url: mcp.broken.example couldn't be reached.")
        let empty = ImportConnectorsResponse.Skipped(name: "x", reason: .failed, message: " ")
        #expect(ImportCopy.reason(empty) == "The connection check failed")
    }

    @Test("result and status lines; the text to import is trimmed and capped")
    func copy() throws {
        let imported = try #require(try M9Samples.decode(ImportConnectorsResponse.self, "m17", "ImportConnectorsResponse").first)
        #expect(ImportCopy.addedLine(imported.connectors[0]) == "Added · Signs in")
        #expect(ImportCopy.addedLine(imported.connectors[1]) == "Added · 1 tool")
        let signedIn = try #require(try M9Samples.decode(CustomConnectorResponse.self, "m17", "CustomConnectorResponse").first?.connector)
        #expect(ConnectorCopy.signedInLine(signedIn) == "Signed in · 2 tools")
        #expect(ImportCopy.request("   ") == nil)
        #expect(ImportCopy.request(" {\"a\":1} ") == ImportConnectorsRequest(json: "{\"a\":1}"))
        #expect(ImportCopy.request(String(repeating: "x", count: ImportCopy.jsonLimit + 1)) == nil)
    }
}
