// M17 logic without SwiftUI (Foundation only; listed in Tools/HostTests/run.sh, not in Models/ so the
// contract check that compiles Models/*.swift alone doesn't need Networking): the sign-in callback URL
// as an OAuthFinishRequest, the install sheet's input rules, a template row's hint and Add / Added
// state, the gallery's pages (featured first, deduplicated, stale answers dropped), the reason
// line of a failed request (the server's own words) and the pasted config's skip reasons.
import Foundation

// MARK: - Errors with the server's words

/// A non-2xx answer of an M17 route with the server's ApiError message kept (APIError drops it for
/// 404 / 409 / 502). `error` is what APIError makes of the same answer.
struct ServerFailure: Error, Hashable, Sendable {
    var status: Int
    var error: APIError
    var code: String?
    var field: String?
    var message: String?

    init(status: Int, body: Data) {
        self.status = status
        error = APIError(status: status, body: body)
        let detail = try? JSONCoding.decoder().decode(ApiErrorBody.self, from: body).error
        code = detail?.code
        field = detail?.field
        let text = detail?.message.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        message = text.isEmpty ? nil : text
    }
}

enum M17Reason {
    /// The APIError behind `error` (a ServerFailure's, or the error itself).
    static func apiError(_ error: any Error) -> APIError? {
        if let failure = error as? ServerFailure { return failure.error }
        return error as? APIError
    }

    /// The field a 400 named ("inputs.token", "json", "code"), if any.
    static func field(_ error: any Error) -> String? {
        if let failure = error as? ServerFailure, failure.status == 400 { return failure.field }
        if case .validationFailed(let field, _)? = error as? APIError { return field }
        return nil
    }

    /// 410: the sign-in's state ran out or was used already.
    static func isExpired(_ error: any Error) -> Bool {
        apiError(error) == .expired
    }

    /// The inline line for a failed request: the server's own message (400, 404, 409, 502, ...),
    /// else APIError's line; nil when it was cancelled. A 401 / unreachable / 429 keeps the app's line.
    static func line(for error: any Error) -> String? {
        if error is CancellationError { return nil }
        guard let failure = error as? ServerFailure else { return fallback(error) }
        switch failure.error {
        case .unauthorized, .unreachable, .rateLimited, .invalidCredentials: return failure.error.localizedReason
        default: return failure.message ?? fallback(failure.error)
        }
    }

    /// The same line without the "<field>: " the server puts in front, for a line shown right
    /// under that field ("inputs.token: required (missing: token)" → "required (missing: token)").
    static func fieldLine(for error: any Error) -> String? {
        guard let line = line(for: error) else { return nil }
        guard let field = field(error), line.hasPrefix(field + ": ") else { return line }
        let rest = String(line.dropFirst(field.count + 2)).trimmingCharacters(in: .whitespaces)
        guard let first = rest.first else { return line }
        return first.uppercased() + rest.dropFirst()
    }

    /// The install input a 400 names (`inputs.<name>`), if any.
    static func inputName(_ error: any Error) -> String? {
        guard let field = field(error), field.hasPrefix("inputs.") else { return nil }
        let name = String(field.dropFirst("inputs.".count))
        return name.isEmpty ? nil : name
    }

    private static func fallback(_ error: any Error) -> String? {
        if error is CancellationError { return nil }
        if case APIError.validationFailed(_, let message)? = error as? APIError {
            let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? String(localized: "Check your answers and try again.") : trimmed
        }
        return (error as? APIError)?.localizedReason ?? String(localized: "Something went wrong.")
    }
}

// MARK: - The sign-in callback

enum OAuthCallback {
    /// The app's registered redirect (docs/API.md M17): duet://oauth/callback.
    static let scheme = "duet"
    static let host = "oauth"
    static let path = "/callback"

    /// Whether a URL is the sign-in callback (the app's link router ignores these).
    static func isCallback(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme && url.host()?.lowercased() == host
    }

    /// The callback's query as POST .../oauth/finish wants it; nil when it isn't the callback or
    /// carries no `state` (nothing to finish). `error_description` is cut to the server's 1000.
    static func finishRequest(from url: URL) -> OAuthFinishRequest? {
        guard isCallback(url), url.path() == path || url.path() == path + "/",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func value(_ name: String) -> String? {
            guard let raw = items.first(where: { $0.name == name })?.value else { return nil }
            let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }
        guard let state = value("state") else { return nil }
        let code = value("code")
        var error = value("error").map { String($0.prefix(200)) }
        // Neither a code nor an error: the server's code exchange can't run; say so.
        if code == nil, error == nil { error = "invalid_request" }
        return OAuthFinishRequest(
            state: state,
            code: error == nil ? code : nil,
            error: error,
            errorDescription: value("error_description").map { String($0.prefix(1000)) }
        )
    }
}

/// What the sign-in sheet answered.
enum SignInOutcome: Hashable, Sendable {
    case signedIn(CustomConnector)
    /// the user closed the web sheet (canceledLogin): no call, no line
    case cancelled
    /// `expired` = 410, the reason's own retry
    case failed(reason: String, expired: Bool)
}

/// A connector page's or a gallery row's sign-in.
enum SignInPhase: Hashable, Sendable {
    case idle
    case running
    case failed(reason: String, expired: Bool)

    var isRunning: Bool { self == .running }

    var failure: String? {
        if case .failed(let reason, _) = self { return reason }
        return nil
    }

    var expired: Bool {
        if case .failed(_, let expired) = self { return expired }
        return false
    }

    /// After a sign-in: cancel goes back to idle (no line), a failure keeps its reason.
    static func after(_ outcome: SignInOutcome) -> SignInPhase {
        switch outcome {
        case .signedIn, .cancelled: .idle
        case .failed(let reason, let expired): .failed(reason: reason, expired: expired)
        }
    }
}

extension CustomConnector {
    /// M17: it waits for the user to sign in (false for servers without sign-in and older servers).
    var needsSignIn: Bool { oauth?.needsSignIn == true }
    /// M17: it uses sign-in and the tokens are stored.
    var isSignedIn: Bool { oauth?.signedIn == true }
}

// MARK: - Template inputs

enum TemplateInputRules {
    /// backend InstallTemplateRequest: values up to 4000; a URL part like install.ts VALUE_IN_URL.
    static let valueLimit = 4000
    static let segmentLimit = 200

    enum Problem: Hashable, Sendable {
        /// a URL part with "/", "?", "#", "@", spaces or other characters the server refuses
        case segment
        /// a header value over more than one line
        case multiline
        case tooLong
    }

    /// The inputs the sheet asks for: only the required ones (optional ones keep their defaults).
    static func asked(_ template: ConnectorTemplate) -> [ConnectorTemplateInput] {
        template.inputs.filter(\.required)
    }

    /// No required inputs: one tap installs it.
    static func isOneTap(_ template: ConnectorTemplate) -> Bool {
        asked(template).isEmpty
    }

    static func clean(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// What's wrong with a typed value (an empty one isn't a problem: it only keeps Add off).
    static func problem(_ input: ConnectorTemplateInput, _ value: String) -> Problem? {
        let text = clean(value)
        guard !text.isEmpty else { return nil }
        switch input.kind {
        case .urlVariable:
            if text.utf16.count > segmentLimit { return .tooLong }
            return isSegment(text) ? nil : .segment
        case .header:
            if text.utf16.count > valueLimit { return .tooLong }
            return text.contains(where: { $0 == "\n" || $0 == "\r" || $0 == "\0" }) ? .multiline : nil
        }
    }

    /// One URL segment as the server takes it: letters, digits and - . _ ~ (plus the few
    /// sub-delimiters install.ts allows); never "/", "?", "#", "@", spaces or braces.
    static func isSegment(_ text: String) -> Bool {
        text.wholeMatch(of: /[A-Za-z0-9._~%:+=,;!*'()$-]{1,200}/) != nil
    }

    /// POST /api/connector-templates/install with the asked values (trimmed); nil while a required
    /// one is empty or a value has a problem.
    static func request(_ template: ConnectorTemplate, values: [String: String]) -> InstallTemplateRequest? {
        var inputs: [String: String] = [:]
        for input in asked(template) {
            let text = clean(values[input.name] ?? "")
            if text.isEmpty || problem(input, text) != nil { return nil }
            inputs[input.name] = text
        }
        return InstallTemplateRequest(name: template.name, inputs: inputs)
    }
}

// MARK: - Gallery rows

enum TemplateHint: Hashable, Sendable {
    /// needsSignIn == true
    case signsIn
    /// no inputs and needsSignIn == false
    case nothingToFill

    var text: LocalizedStringResource {
        switch self {
        case .signsIn: "Signs in"
        case .nothingToFill: "Nothing to fill in"
        }
    }

    /// Only what the server learned (needsSignIn nil = not probed yet: no hint).
    static func of(_ template: ConnectorTemplate) -> TemplateHint? {
        switch template.needsSignIn {
        case true?: .signsIn
        case false? where template.inputs.isEmpty: .nothingToFill
        default: nil
        }
    }
}

enum TemplateRowState: Hashable, Sendable {
    case add
    case installing
    /// the user has it; the id when the connector list knows it
    case added(connectorId: String?)

    /// A row's trailing control. The loaded connector list is the truth for "installed" (a
    /// deleted one turns back to Add); before it loads, the template's own flag.
    static func of(_ template: ConnectorTemplate, connectors: [CustomConnector]?, installing: String?) -> TemplateRowState {
        if installing == template.name { return .installing }
        if let connectors {
            if let match = connectors.first(where: { $0.registryName == template.name }) { return .added(connectorId: match.id) }
            return .add
        }
        return template.installed ? .added(connectorId: nil) : .add
    }
}

// MARK: - Gallery pages

/// GET /api/connector-templates as the page shows it: the first page of a query, more pages via
/// `nextCursor`, each template once, and answers of an older query dropped (`generation`).
struct TemplateGallery: Hashable, Sendable {
    enum Phase: Hashable, Sendable {
        case loading
        case loaded
        case failed(String)
    }

    private(set) var query = ""
    private(set) var templates: [ConnectorTemplate] = []
    private(set) var nextCursor: String?
    private(set) var phase: Phase = .loading
    private(set) var loadingMore = false
    private(set) var moreFailure: String?
    /// a new query is running over the old rows (they stay until it answers)
    private(set) var searching = false
    private(set) var generation = 0

    /// backend ConnectorTemplateQuery: trimmed, ≤ 100 characters.
    static func cleanQuery(_ text: String) -> String {
        String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100))
    }

    /// A new first page (a new query, or Retry): the old rows stay until it answers. Returns the
    /// generation the answer must carry.
    mutating func begin(query text: String) -> Int {
        generation += 1
        query = Self.cleanQuery(text)
        if phase == .loaded, !templates.isEmpty {
            searching = true
        } else {
            phase = .loading
        }
        loadingMore = false
        moreFailure = nil
        return generation
    }

    mutating func received(_ list: ConnectorTemplateList, generation: Int) {
        guard generation == self.generation else { return }
        templates = Self.unique(list.templates)
        nextCursor = list.nextCursor
        phase = .loaded
        searching = false
    }

    mutating func failed(_ reason: String, generation: Int) {
        guard generation == self.generation else { return }
        templates = []
        nextCursor = nil
        phase = .failed(reason)
        searching = false
    }

    /// The next page's cursor, or nil when there's nothing to load (the end, or already loading).
    mutating func beginMore() -> (cursor: String, generation: Int)? {
        guard phase == .loaded, !searching, !loadingMore, let cursor = nextCursor else { return nil }
        loadingMore = true
        moreFailure = nil
        return (cursor, generation)
    }

    mutating func receivedMore(_ list: ConnectorTemplateList, generation: Int) {
        guard generation == self.generation else { return }
        templates = Self.unique(templates + list.templates)
        nextCursor = list.nextCursor
        loadingMore = false
    }

    mutating func failedMore(_ reason: String, generation: Int) {
        guard generation == self.generation else { return }
        loadingMore = false
        moreFailure = reason
    }

    /// An install answered: the template learned whether it signs in.
    mutating func learned(_ name: String, needsSignIn: Bool) {
        guard let index = templates.firstIndex(where: { $0.name == name }) else { return }
        templates[index].needsSignIn = needsSignIn
        templates[index].installed = true
    }

    /// "Featured" in the server's order.
    var featured: [ConnectorTemplate] { templates.filter(\.featured) }
    /// The rest, in the server's order.
    var rest: [ConnectorTemplate] { templates.filter { !$0.featured } }
    /// A search that found nothing ("No servers match").
    var isEmptySearch: Bool { phase == .loaded && templates.isEmpty && !query.isEmpty }
    var hasMore: Bool { nextCursor != nil }

    private static func unique(_ templates: [ConnectorTemplate]) -> [ConnectorTemplate] {
        var seen = Set<String>()
        return templates.filter { seen.insert($0.name).inserted }
    }
}

// MARK: - Pasted configs

enum ImportCopy {
    /// backend ImportConnectorsRequest.json: ≤ 100 000 characters (UTF-16, like zod).
    static let jsonLimit = 100_000

    /// The text to send; nil when it's empty or over the limit.
    static func request(_ text: String) -> ImportConnectorsRequest? {
        let json = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !json.isEmpty, json.utf16.count <= jsonLimit else { return nil }
        return ImportConnectorsRequest(json: json)
    }

    /// The app's words for a skip reason; nil = show the server's message (invalid, failed and a
    /// newer server's reason carry the details there).
    static func reasonKey(_ reason: ImportConnectorsResponse.Skipped.Reason) -> LocalizedStringResource? {
        switch reason {
        case .stdio: "Runs a program on your computer; a hosted server can't run it"
        case .exists: "You have a connector with this address already"
        case .invalid, .failed, .other: nil
        }
    }

    /// The plain reason of a skipped entry: the app's words, else the server's message, else a
    /// general line.
    static func reason(_ skipped: ImportConnectorsResponse.Skipped) -> String {
        if let key = reasonKey(skipped.reason) { return String(localized: key) }
        let message = skipped.message.trimmingCharacters(in: .whitespacesAndNewlines)
        if !message.isEmpty { return message }
        return skipped.reason == .failed
            ? String(localized: "The connection check failed")
            : String(localized: "This entry can't be used")
    }

    /// "Added · Signs in" / "Added · 4 tools" for a connector the paste created.
    static func addedLine(_ connector: CustomConnector) -> String {
        let second: LocalizedStringResource = connector.needsSignIn ? "Signs in" : ConnectorCopy.toolCount(connector.tools.count)
        return [String(localized: "Added"), String(localized: second)].joined(separator: " · ")
    }
}

extension ConnectorCopy {
    /// "Signed in · 23 tools" under a signed-in connector's status.
    static func signedInLine(_ connector: CustomConnector) -> String {
        [String(localized: "Signed in"), String(localized: toolCount(connector.tools.count))].joined(separator: " · ")
    }
}
