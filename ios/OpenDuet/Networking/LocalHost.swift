// Which hosts may use plain http (prompt L173): this device and the local network only.
// localhost and *.local, private IPv4 (10/8, 172.16/12, 192.168/16), link-local 169.254/16,
// CGNAT 100.64/10 (Tailscale), loopback, and IPv6 unique-local (fc00::/7) and link-local
// (fe80::/10). Every other host must use https. Foundation only (host tests).
import Foundation

enum LocalHost {
    static func isLocal(_ rawHost: String) -> Bool {
        var host = rawHost.lowercased()
        if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        // IPv6 zone index ("fe80::1%en0").
        if let percent = host.firstIndex(of: "%") { host = String(host[..<percent]) }
        while host.hasSuffix(".") { host.removeLast() }
        guard !host.isEmpty else { return false }

        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") { return true }
        if let v4 = ipv4(host) { return isLocalIPv4(v4) }
        if let v6 = ipv6(host) { return isLocalIPv6(v6) }
        return false
    }

    /// Strict dotted quad: four decimal octets 0-255 (no shorthand, hex or octal forms).
    static func ipv4(_ host: String) -> [UInt8]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [UInt8] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let value = UInt8(part) else { return nil }
            octets.append(value)
        }
        return octets
    }

    static func ipv6(_ host: String) -> [UInt8]? {
        guard host.contains(":") else { return nil }
        var address = in6_addr()
        guard inet_pton(AF_INET6, host, &address) == 1 else { return nil }
        return withUnsafeBytes(of: address) { Array($0) }
    }

    private static func isLocalIPv4(_ o: [UInt8]) -> Bool {
        switch (o[0], o[1]) {
        case (10, _), (127, _): true
        case (172, 16...31): true
        case (192, 168): true
        case (169, 254): true
        case (100, 64...127): true
        default: false
        }
    }

    private static func isLocalIPv6(_ b: [UInt8]) -> Bool {
        let loopback = b.dropLast().allSatisfy { $0 == 0 } && b.last == 1
        let uniqueLocal = b[0] & 0xFE == 0xFC
        let linkLocal = b[0] == 0xFE && b[1] & 0xC0 == 0x80
        return loopback || uniqueLocal || linkLocal
    }
}
