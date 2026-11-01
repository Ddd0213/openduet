// The app's Codable models against docs/api-samples/ (bundled as the "api-samples" folder).
import Foundation
import Testing
@testable import OpenDuet

private final class BundleToken {}

@Suite("API contract samples")
struct ContractSamplesTests {
    @Test("Every sample decodes, and request samples re-encode to the same JSON")
    func samplesMatchModels() throws {
        let bundle = Bundle(for: BundleToken.self)
        let directory = try #require(bundle.url(forResource: "api-samples", withExtension: nil))
        let report = try ContractSamples.check(directory: directory)
        for error in report.errors {
            Issue.record(Comment(rawValue: error))
        }
        #expect(report.checkedSamples > 0)
    }

    @Test("Server phrase keys come back as structured params, never preformatted dates")
    func phraseParamsStayStructured() throws {
        let json = #"{"key":"system.reminder_set","params":{"at":{"type":"datetime","value":"2026-10-26T17:00:00.000Z"}}}"#
        let phrase = try JSONCoding.decoder().decode(Phrase.self, from: Data(json.utf8))
        #expect(phrase.key == "system.reminder_set")
        guard case let .datetime(date) = phrase.params?["at"] else {
            Issue.record("expected a datetime param")
            return
        }
        #expect(date == JSONCoding.parseDate("2026-10-26T17:00:00Z"))
    }
}
