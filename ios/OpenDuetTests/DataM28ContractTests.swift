// M28 contract: the signed-in devices. SessionList decodes in the server's order (current first),
// skips a row it can't read, and reads missing fields as nil / false; an empty string reads nil.
// RevokeOtherSessionsResponse reads `revoked`. DeviceNameHeader mirrors the server's X-Device-Name rule.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M28 sessions contract")
struct DataM28ContractTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    private let list = #"""
    {"sessions":[
      {"id":"S1","current":true,"createdAt":"2026-11-02T09:14:00.000Z","lastUsedAt":"2026-11-20T18:42:10.000Z",
       "expiresAt":"2027-01-31T09:14:00.000Z","deviceName":"iPhone 15 Pro","userAgent":"OpenDuet/1 CFNetwork",
       "signInIp":"203.0.113.24","lastIp":"198.51.100.7","push":true},
      {"id":"S2","current":false,"createdAt":"2026-11-05T21:03:00.000Z","lastUsedAt":"2026-11-19T07:30:00.000Z",
       "expiresAt":"2027-02-03T21:03:00.000Z","deviceName":"iPad Air","userAgent":null,
       "signInIp":"203.0.113.24","lastIp":"203.0.113.24","push":false},
      {"id":"S3","current":false,"createdAt":"2026-10-26T14:20:00.000Z","lastUsedAt":null,
       "expiresAt":"2027-01-24T14:20:00.000Z","deviceName":null,"userAgent":null,"signInIp":null,"lastIp":null,"push":false}
    ]}
    """#

    @Test("A list decodes in the server's order; current and others split it")
    func fullList() throws {
        let value = try decode(SessionList.self, list)
        #expect(value.sessions.map(\.id) == ["S1", "S2", "S3"])
        #expect(value.current?.id == "S1" && value.others.map(\.id) == ["S2", "S3"])
        let first = value.sessions[0]
        #expect(first.deviceName == "iPhone 15 Pro" && first.push && first.lastIp == "198.51.100.7" && first.signInIp == "203.0.113.24")
        #expect(first.createdAt == JSONCoding.parseDate("2026-11-02T09:14:00.000Z"))
        #expect(first.expiresAt == JSONCoding.parseDate("2027-01-31T09:14:00.000Z"))
        let old = value.sessions[2]
        #expect(old.lastUsedAt == nil && old.deviceName == nil && old.userAgent == nil && old.lastIp == nil && !old.push)
    }

    @Test("A row without an id or createdAt is skipped; missing fields read nil / false; \"\" reads nil")
    func tolerantRows() throws {
        let json = #"""
        {"sessions":[{"current":true,"createdAt":"2026-11-02T09:14:00.000Z"},
                     "not a row",
                     {"id":"S8","createdAt":"soon"},
                     {"id":"S9","createdAt":"2026-11-02T09:14:00Z","userAgent":"","deviceName":7,"push":"yes","extra":{"a":1}}]}
        """#
        let value = try decode(SessionList.self, json)
        #expect(value.sessions.map(\.id) == ["S9"])
        let row = value.sessions[0]
        #expect(!row.current && !row.push && row.userAgent == nil && row.deviceName == nil && row.lastUsedAt == nil)
        // no readable expiresAt: createdAt + 90 days
        #expect(row.expiresAt == row.createdAt.addingTimeInterval(90 * 24 * 60 * 60))
        #expect(value.current == nil)
    }

    @Test("An empty or odd list reads as no devices")
    func emptyList() throws {
        #expect(try decode(SessionList.self, #"{"sessions":[]}"#).sessions.isEmpty)
        #expect(try decode(SessionList.self, "{}").sessions.isEmpty)
        #expect(try decode(SessionList.self, #"{"sessions":{"id":"S1"}}"#).sessions.isEmpty)
    }

    @Test("revoke-others reads how many were signed out")
    func revokeOthers() throws {
        #expect(try decode(RevokeOtherSessionsResponse.self, #"{"revoked":2}"#).revoked == 2)
        #expect(try decode(RevokeOtherSessionsResponse.self, #"{"revoked":0}"#).revoked == 0)
        #expect(try decode(RevokeOtherSessionsResponse.self, "{}").revoked == 0)
    }

    @Test("X-Device-Name: trimmed printable ASCII, 1-64 characters, else no header")
    func deviceNameHeader() {
        #expect(DeviceNameHeader.field == "X-Device-Name")
        #expect(DeviceNameHeader.header("  iPhone 15 Pro ") == "iPhone 15 Pro")
        #expect(DeviceNameHeader.header(String(repeating: "x", count: 64)) == String(repeating: "x", count: 64))
        for bad: String? in [nil, "", "   ", String(repeating: "x", count: 65), "iPhone\t15", "Alex’s iPhone", "林晓的 iPhone"] {
            #expect(DeviceNameHeader.header(bad) == nil)
        }
    }
}
