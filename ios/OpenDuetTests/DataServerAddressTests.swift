// Server address rules (prompt L131, L173): trim, default to https, plain http only for hosts
// on the local network, and paths that can't leave the signed-in server.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Server address")
struct DataServerAddressTests {
    private func parsed(_ input: String) -> String? {
        try? ServerAddress.parse(input).get().string
    }

    private func error(_ input: String) -> ServerAddress.ParseError? {
        if case .failure(let e) = ServerAddress.parse(input) { e } else { nil }
    }

    @Test("Trims, adds https:// when there is no scheme, lowercases and drops trailing slashes")
    func normalizes() {
        #expect(parsed("  duet.example.com \n") == "https://duet.example.com")
        #expect(parsed("HTTPS://Duet.Example.COM/") == "https://duet.example.com")
        #expect(parsed("https://duet.example.com:8443/duet//") == "https://duet.example.com:8443/duet")
        #expect(parsed("192.168.1.10:3000") == "https://192.168.1.10:3000")
        #expect(parsed("localhost:3000") == "https://localhost:3000")
    }

    @Test("http is allowed for local hosts", arguments: [
        "http://localhost:3000", "http://127.0.0.1:3000", "http://duet.local", "http://mac-mini.local.:3000",
        "http://10.0.0.5", "http://172.16.0.1", "http://172.31.255.255", "http://192.168.1.10:3000",
        "http://169.254.10.20", "http://100.64.0.1", "http://100.127.255.254",
        "http://[::1]:3000", "http://[fd12:3456:789a::1]:3000", "http://[fc00::1]", "http://[fe80::1%25en0]:3000", "http://[FE80::abcd]",
    ])
    func localHTTP(_ input: String) {
        #expect(parsed(input) != nil, "\(input) should be allowed")
    }

    @Test("http to a public host is refused", arguments: [
        "http://duet.example.com", "http://8.8.8.8", "http://172.32.0.1", "http://172.15.255.255", "http://192.169.1.1",
        "http://100.128.0.1", "http://100.63.255.255", "http://11.0.0.1", "http://[2001:db8::1]", "http://[fec0::1]",
        "http://localhost.example.com", "http://192.168.1", "http://0x0a.0.0.1",
    ])
    func publicHTTP(_ input: String) {
        #expect(error(input) == .insecurePublicHost, "\(input) should be refused")
    }

    @Test("https works for any host")
    func publicHTTPS() {
        #expect(parsed("https://8.8.8.8") == "https://8.8.8.8")
        #expect(parsed("https://[2001:db8::1]:443") == "https://[2001:db8::1]:443")
    }

    @Test("Malformed input is rejected", arguments: [
        "https://", "ftp://duet.example.com", "ws://duet.example.com", "https://user:pw@duet.example.com",
        "https://duet.example.com?x=1", "https://duet.example.com#top", "https://host:99999", "https://exa mple.com", "https://:3000",
    ])
    func invalid(_ input: String) {
        #expect(error(input) == .invalid, "\(input) should be invalid")
    }

    @Test("Empty input")
    func empty() {
        #expect(error("   ") == .empty)
    }

    @Test("Server paths join onto the base path and can't point anywhere else")
    func paths() throws {
        let server = try ServerAddress.parse("https://duet.example.com/base").get()
        #expect(server.url(path: "/api/me")?.absoluteString == "https://duet.example.com/base/api/me")
        let page = server.url(path: "/api/channels/ch_1/messages", query: [URLQueryItem(name: "before", value: "m_9")])
        #expect(page?.absoluteString == "https://duet.example.com/base/api/channels/ch_1/messages?before=m_9")
        for hostile in ["//evil.example.com/x", "https://evil.example.com/x", "api/me", "/\\evil.example.com", "@evil.example.com"] {
            #expect(server.url(path: hostile) == nil, "\(hostile) must be refused")
        }
    }

    @Test("Path segments are escaped")
    func pathSegment() {
        #expect("a/b?c#d".pathSegment == "a%2Fb%3Fc%23d")
        #expect("ch_main".pathSegment == "ch_main")
    }
}
