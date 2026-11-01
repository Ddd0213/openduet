// Every server-built phrase key (backend/src/i18n/{en,zh-Hans}.json "phrases") must be in the
// String Catalog with the same English and Chinese text: PhraseFormatter looks the key up there,
// and a missing key shows as raw "system.no_model" in the app.
import Foundation
import Testing

@Suite("Phrase catalog")
struct DataPhraseCatalogTests {
    private static let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private static func json(_ path: String) throws -> [String: Any] {
        let url = repo.appending(path: path)
        try #require(FileManager.default.fileExists(atPath: url.path), "\(path) not found at \(url.path)")
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        return try #require(object as? [String: Any], "\(path) is not a JSON object")
    }

    private static func phrases(_ path: String) throws -> [String: String] {
        let root = try json(path)
        return try #require(root["phrases"] as? [String: String], "\(path) has no \"phrases\" strings")
    }

    private static func value(_ entry: [String: Any]?, _ language: String) -> String? {
        let localizations = entry?["localizations"] as? [String: Any]
        let unit = (localizations?[language] as? [String: Any])?["stringUnit"] as? [String: Any]
        return unit?["value"] as? String
    }

    private static func placeholders(_ text: String) -> Set<String> {
        var names = Set<String>()
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
            names.insert(String(rest[rest.index(after: open)..<close]))
            rest = rest[rest.index(after: close)...]
        }
        return names
    }

    @Test("Every backend phrase key is in the catalog with the backend's en and zh-Hans text")
    func everyKeyTranslated() throws {
        let en = try Self.phrases("backend/src/i18n/en.json")
        let zh = try Self.phrases("backend/src/i18n/zh-Hans.json")
        let strings = try #require(try Self.json("ios/OpenDuet/Resources/Localizable.xcstrings")["strings"] as? [String: Any])
        #expect(!en.isEmpty)
        #expect(Set(en.keys) == Set(zh.keys), "backend en / zh-Hans keys differ")
        for key in en.keys.sorted() {
            let entry = strings[key] as? [String: Any]
            #expect(entry != nil, "missing in the String Catalog: \(key)")
            #expect(Self.value(entry, "en") == en[key], "catalog en differs from the backend: \(key)")
            #expect(Self.value(entry, "zh-Hans") == zh[key], "catalog zh-Hans differs from the backend: \(key)")
            if let english = en[key], let chinese = zh[key] {
                #expect(Self.placeholders(english) == Self.placeholders(chinese), "placeholders differ: \(key)")
            }
        }
    }
}
