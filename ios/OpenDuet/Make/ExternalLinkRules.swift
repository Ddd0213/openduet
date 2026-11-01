// M20 (#7, review-make.md P1-6): a link in a Make page that leaves for an unknown site, or that
// carries a long query, asks once before it opens. A page's script (or an instruction injected
// into what the build read) could pack private data into a link's query and wait for a tap.
// Known = the host's registrable domain is one of the artifact's sources' (ArtifactDetail.sources;
// a viewer without them yet treats every host as unknown). Pure Foundation, host-tested.
import Foundation

enum ExternalLinkRules {
    /// Query + fragment longer than this (as sent, percent-encoded) asks, whatever the host.
    static let maxTail = 200

    /// Whether an http(s) link needs the "Open <host>?" confirmation. `sources` nil = the
    /// artifact's sources aren't loaded yet. Links without a host always ask.
    static func needsConfirmation(_ url: URL, sources: [ArtifactSource]?) -> Bool {
        guard let host = host(of: url) else { return true }
        if tailLength(url) > maxTail { return true }
        let known = Set((sources ?? []).flatMap(hosts(in:)).map(registrableDomain))
        return !known.contains(registrableDomain(host))
    }

    /// The host the dialog names in full: lowercased, IDN labels as punycode (what the browser
    /// will really open; a look-alike Unicode name can't pass for a known one).
    static func host(of url: URL) -> String? {
        url.host(percentEncoded: false).flatMap(normalized)
    }

    /// The URL with its middle cut out when it's long: the start (scheme, host, path) and the end
    /// stay readable.
    static func shortened(_ url: URL, limit: Int = 80) -> String {
        let text = url.absoluteString
        guard text.count > limit, limit > 10 else { return text }
        let head = (limit - 1) * 3 / 5
        let tail = limit - 1 - head
        return String(text.prefix(head)) + "…" + String(text.suffix(tail))
    }

    // MARK: - Pieces (internal for the tests)

    /// Length of the query and the fragment as they go on the wire.
    static func tailLength(_ url: URL) -> Int {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return 0 }
        return (parts.percentEncodedQuery?.count ?? 0) + (parts.percentEncodedFragment?.count ?? 0)
    }

    /// The hosts a source names: URLs and bare domains in its detail, name or app
    /// ("docs.google.com/spreadsheets/d/1", "https://stripe.com/docs", "example.org").
    static func hosts(in source: ArtifactSource) -> [String] {
        let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ",;()[]<>\"'“”「」，；（）"))
        let text = [source.detail, source.name, source.app ?? ""].joined(separator: " ")
        return text.components(separatedBy: separators).compactMap(host(inToken:))
    }

    /// A host, lowercased, without a trailing dot, IDN labels as punycode; nil if it isn't one.
    static func normalized(_ host: String) -> String? {
        var host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        while host.hasSuffix(".") { host.removeLast() }
        guard !host.isEmpty else { return nil }
        // The URL parser applies IDNA (bücher.de -> xn--bcher-kva.de) and keeps ASCII as written.
        let ascii = URL(string: "https://\(host)/")?.host(percentEncoded: false) ?? host
        let lowered = ascii.lowercased()
        return lowered.isEmpty ? nil : lowered
    }

    /// The part of a host one owner controls: "mail.google.com" -> "google.com",
    /// "news.bbc.co.uk" -> "bbc.co.uk", "alex.github.io" stays (each user owns their own).
    static func registrableDomain(_ host: String) -> String {
        let labels = host.split(separator: ".").map(String.init)
        guard labels.count > 2, let last = labels.last, last.allSatisfy(\.isLetter) || last.hasPrefix("xn--") else {
            return host
        }
        var keep = 2
        let lastTwo = labels.suffix(2).joined(separator: ".")
        if sharedHosts.contains(lastTwo) {
            keep = 3
        } else if last.count == 2, secondLevel.contains(labels[labels.count - 2]) {
            keep = 3
        }
        return labels.suffix(keep).joined(separator: ".")
    }

    /// Second-level labels under a country code that are a public suffix ("co.uk", "com.cn").
    private static let secondLevel: Set<String> = [
        "co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "mil", "nic", "ltd", "plc", "sch",
    ]

    /// Hosting where every subdomain belongs to someone else.
    private static let sharedHosts: Set<String> = [
        "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "herokuapp.com",
        "appspot.com", "web.app", "firebaseapp.com", "blogspot.com", "wordpress.com", "substack.com",
        "notion.site", "glitch.me", "repl.co", "onrender.com", "fly.dev", "azurewebsites.net",
        "cloudfront.net", "s3.amazonaws.com",
    ]

    /// One word of a source's text as a host: an http(s) URL's host, or a bare "name.tld" (with an
    /// optional path); not an email address or a file name.
    private static func host(inToken token: String) -> String? {
        let token = token.trimmingCharacters(in: CharacterSet(charactersIn: ".:!?"))
        guard !token.isEmpty, !token.contains("@") else { return nil }
        let lower = token.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            return URL(string: token).flatMap { $0.host(percentEncoded: false) }.flatMap(normalized)
        }
        guard !token.contains("://") else { return nil }
        let bare = String(token.split(separator: "/", maxSplits: 1).first ?? "")
        let name = String(bare.split(separator: ":", maxSplits: 1).first ?? "")
        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, labels.allSatisfy({ !$0.isEmpty }),
              let last = labels.last, last.count >= 2, last.allSatisfy(\.isLetter),
              name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "." }),
              !fileExtensions.contains(last.lowercased())
        else { return nil }
        return normalized(name)
    }

    /// "report.pdf" names a file, not a site.
    private static let fileExtensions: Set<String> = [
        "pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx", "txt", "md", "json", "png", "jpg", "jpeg",
        "gif", "webp", "heic", "html", "htm", "zip", "key", "numbers", "pages", "rtf",
    ]
}
