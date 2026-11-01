// The OpenDuet server the app signs in to (prompt L131, L173). Typed addresses are trimmed,
// get https:// when no scheme is given, and plain http is only allowed for local hosts
// (LocalHost.isLocal); a public host over http is refused. Foundation only, so the rules run
// in the Mac host tests.
import Foundation

struct ServerAddress: Hashable, Sendable {
    /// Scheme, host, optional port and optional base path; never a trailing slash.
    let url: URL

    enum ParseError: Error, Hashable, Sendable {
        case empty
        case invalid
        /// http:// to a host that isn't on the local network.
        case insecurePublicHost
    }

    /// The canonical form shown in the field and used as the Keychain account.
    var string: String { url.absoluteString }

    var host: String { url.host(percentEncoded: false) ?? "" }

    static func parse(_ input: String) -> Result<ServerAddress, ParseError> {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure(.empty) }
        let lower = trimmed.lowercased()
        let hasScheme = lower.hasPrefix("http://") || lower.hasPrefix("https://")
        if !hasScheme && trimmed.contains("://") { return .failure(.invalid) }
        let candidate = hasScheme ? trimmed : "https://" + trimmed

        guard var parts = URLComponents(string: candidate),
              let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil
        else { return .failure(.invalid) }
        if let port = parts.port, !(1...65535).contains(port) { return .failure(.invalid) }
        if host.contains(where: { $0.isWhitespace }) { return .failure(.invalid) }

        parts.scheme = scheme
        parts.host = host.lowercased()
        var path = parts.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        parts.percentEncodedPath = path

        if scheme == "http" && !LocalHost.isLocal(host) { return .failure(.insecurePublicHost) }
        guard let url = parts.url else { return .failure(.invalid) }
        return .success(ServerAddress(url: url))
    }

    /// The absolute URL of a server-relative path ("/api/me", ChannelFile.url). Anything that
    /// isn't a plain path on this server (another host, "//host", a scheme) is refused so the
    /// bearer token never leaves the signed-in server.
    func url(path: String, query: [URLQueryItem] = []) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("://"), !path.contains("\\") else { return nil }
        guard var parts = URLComponents(string: url.absoluteString + path) else { return nil }
        if !query.isEmpty { parts.queryItems = (parts.queryItems ?? []) + query }
        guard let result = parts.url, result.host(percentEncoded: false)?.lowercased() == host.lowercased() else { return nil }
        return result
    }
}

extension String {
    /// This id escaped as one URL path segment ("/", "?" and "#" included).
    var pathSegment: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? self
    }
}
