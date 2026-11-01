// M12 Add provider and the provider's edit form, without SwiftUI for the host tests: the rules
// the server also checks (an https base URL with no credentials, query or fragment; header names
// of letters, digits and dashes that aren't credentials), the drafts and their request bodies, and
// dropping the key the moment it was sent (a refused form keeps everything else). M27: Gemini and
// StepFun edit without a Base URL; StepFun's region (ProviderRegionRules.swift).
import Foundation

enum ProviderFormRules {
    static let nameLimit = 60
    static let urlLimit = 500
    static let keyLimit = 500
    static let maxHeaders = 10
    static let headerValueLimit = 2000

    static func clean(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    enum URLCheck: Hashable, Sendable {
        case ok
        /// not a base URL at all (no host, credentials, query, fragment, spaces, another scheme)
        case invalid
        /// http to a public host: the server only allows https there
        case needsHTTPS
    }

    /// A provider's base URL. http is fine for localhost and private addresses (a self-hosted
    /// gateway; the server decides with LLM_ALLOW_INSECURE_HOSTS), https everywhere else.
    static func checkURL(_ text: String) -> URLCheck {
        let text = clean(text)
        guard !text.isEmpty, text.count <= urlLimit, !text.contains(where: \.isWhitespace),
              let url = URLComponents(string: text), let scheme = url.scheme?.lowercased(),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return .invalid }
        switch scheme {
        case "https": return .ok
        case "http": return isLocalHost(host) ? .ok : .needsHTTPS
        default: return .invalid
        }
    }

    /// localhost, *.local, a single-label name (a Docker service) or a private / loopback address.
    static func isLocalHost(_ host: String) -> Bool {
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") || host.hasSuffix(".internal") { return true }
        if host.contains(":") { return host == "::1" || host.hasPrefix("fc") || host.hasPrefix("fd") }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        if parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) {
            switch (parts[0], parts[1]) {
            case (127, _), (10, _), (192, 168): return true
            case (172, 16...31): return true
            case (100, 64...127): return true
            default: return false
            }
        }
        return !host.contains(".") && !host.contains(":")
    }

    /// Header names the server refuses: credentials go in the key.
    static func isCredentialName(_ name: String) -> Bool {
        clean(name).lowercased().contains(/(authorization|cookie|secret|token|api[-_]?key|credential)/)
    }

    static func isHeaderName(_ name: String) -> Bool {
        clean(name).wholeMatch(of: /[A-Za-z0-9-]{1,64}/) != nil
    }
}

/// One extra header row (name, value). Not secret: credentials go in the key.
struct ProviderHeaderDraft: Hashable, Sendable, Identifiable {
    var id = UUID()
    var name = ""
    var value = ""
}

enum ProviderFormProblem: Hashable, Sendable {
    case name, url, urlNeedsHTTPS, key
    /// the edit form: a changed base URL needs the key typed again (the server won't send the stored one)
    case keyForNewURL
    case headerName, credentialHeader, duplicateHeader, headerValue, tooManyHeaders
}

/// The rules both forms share for the header rows.
enum ProviderHeaderRules {
    /// Rows the user left completely empty are ignored.
    static func filled(_ rows: [ProviderHeaderDraft]) -> [ProviderHeaderDraft] {
        rows.filter { !ProviderFormRules.clean($0.name).isEmpty || !ProviderFormRules.clean($0.value).isEmpty }
    }

    static func problems(_ rows: [ProviderHeaderDraft]) -> Set<ProviderFormProblem> {
        var problems = Set<ProviderFormProblem>()
        let rows = filled(rows)
        if rows.count > ProviderFormRules.maxHeaders { problems.insert(.tooManyHeaders) }
        let names = rows.map { ProviderFormRules.clean($0.name) }
        for name in names {
            if !ProviderFormRules.isHeaderName(name) { problems.insert(.headerName) }
            if ProviderFormRules.isCredentialName(name) { problems.insert(.credentialHeader) }
        }
        if Set(names.map { $0.lowercased() }).count != names.count { problems.insert(.duplicateHeader) }
        if rows.contains(where: { $0.value.count > ProviderFormRules.headerValueLimit }) { problems.insert(.headerValue) }
        return problems
    }

    /// The problem of one row, for the line under it.
    static func problem(_ row: ProviderHeaderDraft, in rows: [ProviderHeaderDraft]) -> ProviderFormProblem? {
        let name = ProviderFormRules.clean(row.name)
        guard !name.isEmpty || !ProviderFormRules.clean(row.value).isEmpty else { return nil }
        if !ProviderFormRules.isHeaderName(name) { return .headerName }
        if ProviderFormRules.isCredentialName(name) { return .credentialHeader }
        let same = filled(rows).filter { ProviderFormRules.clean($0.name).caseInsensitiveCompare(name) == .orderedSame }
        return same.count > 1 ? .duplicateHeader : nil
    }

    static func headers(_ rows: [ProviderHeaderDraft]) -> [ProviderHeader] {
        filled(rows).map { ProviderHeader(name: ProviderFormRules.clean($0.name), value: ProviderFormRules.clean($0.value)) }
    }
}

/// Add provider as typed. Presets use their own address; custom asks for the protocol, the base
/// URL and (Anthropic-compatible) how the key is sent. M27: StepFun picks its region (sent only
/// when the server offers regions for the kind, `offersRegion`; nil lets the server pick).
struct ProviderDraft: Hashable, Sendable {
    var kind: ProviderKind
    var wireProtocol: ProviderProtocol = .openai
    var auth: ProviderAuth = .xApiKey
    var name = ""
    var baseUrl = ""
    /// typed into a SecureField; dropped as soon as the request is built
    var key = ""
    var headers: [ProviderHeaderDraft] = []
    /// M27: the site (StepFun); nil = the server's default for this phone
    var region: ProviderRegion?
    /// M27: the server listed regions for this kind (an older server takes no `region`)
    var offersRegion = false

    init(kind: ProviderKind) { self.kind = kind }

    var isCustom: Bool { kind == .custom }
    /// "Send the key as" shows for an Anthropic-compatible custom provider only.
    var asksAuth: Bool { isCustom && wireProtocol == .anthropic }

    var problems: Set<ProviderFormProblem> {
        var problems = ProviderHeaderRules.problems(headers)
        if ProviderFormRules.clean(name).count > ProviderFormRules.nameLimit { problems.insert(.name) }
        if ProviderFormRules.clean(key).count > ProviderFormRules.keyLimit { problems.insert(.key) }
        if isCustom, !ProviderFormRules.clean(baseUrl).isEmpty {
            switch ProviderFormRules.checkURL(baseUrl) {
            case .ok: break
            case .invalid: problems.insert(.url)
            case .needsHTTPS: problems.insert(.urlNeedsHTTPS)
            }
        }
        return problems
    }

    /// The key is typed and, for custom, the base URL.
    var isComplete: Bool {
        guard !ProviderFormRules.clean(key).isEmpty else { return false }
        return !isCustom || !ProviderFormRules.clean(baseUrl).isEmpty
    }

    var canSave: Bool { isComplete && problems.isEmpty }

    /// POST /api/providers; nil until the form can be saved.
    var request: CreateModelProviderRequest? {
        guard canSave else { return nil }
        let name = ProviderFormRules.clean(name)
        let headers = ProviderHeaderRules.headers(headers)
        return CreateModelProviderRequest(
            kind: kind,
            wireProtocol: isCustom ? wireProtocol : nil,
            name: name.isEmpty ? nil : name,
            baseUrl: isCustom ? ProviderFormRules.clean(baseUrl) : nil,
            auth: asksAuth ? auth : nil,
            key: ProviderFormRules.clean(key),
            headers: headers.isEmpty ? nil : headers,
            region: offersRegion ? region : nil
        )
    }

    /// Save was tapped: the key leaves the form (sent once, never kept); the rest stays for a 400.
    mutating func dropSecrets() {
        key = ""
    }
}

/// A provider's edit form (rename, a new key, base URL, how the key is sent, headers). The key
/// field starts empty: blank keeps the one in the vault.
struct ProviderEditDraft: Hashable, Sendable {
    var name: String
    var baseUrl: String
    var auth: ProviderAuth
    var key = ""
    var headers: [ProviderHeaderDraft]

    let original: ModelProvider

    init(_ provider: ModelProvider) {
        original = provider
        name = provider.name
        baseUrl = provider.baseUrl
        auth = provider.auth ?? .xApiKey
        headers = provider.headers.map { ProviderHeaderDraft(name: $0.name, value: $0.value) }
    }

    var asksAuth: Bool { original.wireProtocol == .anthropic }

    /// M27: Gemini and StepFun have no Base URL row (the address follows the kind and region).
    var showsBaseURL: Bool { !ProviderFormLayout.hasFixedAddress(original.kind) }

    var problems: Set<ProviderFormProblem> {
        var problems = ProviderHeaderRules.problems(headers)
        let name = ProviderFormRules.clean(name)
        if name.isEmpty || name.count > ProviderFormRules.nameLimit { problems.insert(.name) }
        if ProviderFormRules.clean(key).count > ProviderFormRules.keyLimit { problems.insert(.key) }
        guard showsBaseURL else { return problems }
        switch ProviderFormRules.checkURL(baseUrl) {
        case .ok: break
        case .invalid: problems.insert(.url)
        case .needsHTTPS: problems.insert(.urlNeedsHTTPS)
        }
        // The server never sends a stored key to a new address: a changed URL needs the key typed again.
        if ProviderFormRules.clean(baseUrl) != original.baseUrl, ProviderFormRules.clean(key).isEmpty { problems.insert(.keyForNewURL) }
        return problems
    }

    /// PATCH /api/providers/:id with only what changed; nil when nothing did (or it can't be saved).
    var request: UpdateModelProviderRequest? {
        guard problems.isEmpty else { return nil }
        var body = UpdateModelProviderRequest()
        let name = ProviderFormRules.clean(name)
        if name != original.name { body.name = name }
        let url = ProviderFormRules.clean(baseUrl)
        if showsBaseURL, url != original.baseUrl { body.baseUrl = url }
        if asksAuth, auth != (original.auth ?? .xApiKey) { body.auth = auth }
        let key = ProviderFormRules.clean(key)
        if !key.isEmpty { body.key = key }
        let headers = ProviderHeaderRules.headers(headers)
        if headers != original.headers { body.headers = headers }
        return body == UpdateModelProviderRequest() ? nil : body
    }

    /// The change makes the server check the provider again (anything but the name).
    var rechecks: Bool {
        guard let body = request else { return false }
        return body.baseUrl != nil || body.auth != nil || body.key != nil || body.headers != nil
    }

    mutating func dropSecrets() {
        key = ""
    }
}
