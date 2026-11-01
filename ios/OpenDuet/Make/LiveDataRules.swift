// M27 (docs/API.md "## M27"): a dashboard's live data reaches the open page without a reload. The
// served page carries `<script type="application/json" id="duet-data" data-version="N">`; the
// app reads N from the HTML it loaded, hands newer JSON to the page with one script (the JSON and
// the version go in as arguments, never into the script text), fetches GET /data once per
// artifact at a time, and refetches the page before Share once hand-overs moved past the HTML it
// loaded. Pure Foundation (host-tested).
import Foundation

enum LiveDataRules {
    /// The data-version of the page's first `<script type="application/json" id="duet-data">`
    /// (`ArtifactLiveData`); nil when the page has none. Script bodies and comments are skipped,
    /// so a page whose text or code mentions duet-data doesn't count. A missing or bad number
    /// reads 0, as the page runtime reads it.
    static func htmlDataVersion(_ html: String) -> Int? {
        // Every page without data (docs, slides, dashboards before M27) leaves here.
        guard html.contains(ArtifactLiveData.elementId) else { return nil }
        var copy = html
        return copy.withUTF8 { scan($0) }
    }

    /// The hand-over, run in the app's content world with `json` and `version` as arguments:
    /// the text first, then the attribute (the page runtime's MutationObserver on data-version
    /// re-reads the text, so it works even if the event doesn't reach the page's world), then the
    /// event. Returns the version the page shows now, or -1 when it has no data element.
    static let handOverScript: String = {
        let id = literal(ArtifactLiveData.elementId)
        let attribute = literal(ArtifactLiveData.versionAttribute)
        let event = literal(ArtifactLiveData.event)
        return """
        const el = document.getElementById(\(id));
        if (!el) return -1;
        const shown = Number(el.getAttribute(\(attribute))) || 0;
        if (version <= shown) return shown;
        el.textContent = json;
        el.setAttribute(\(attribute), String(version));
        document.dispatchEvent(new Event(\(event)));
        return version;
        """
    }()

    /// The script's arguments: the JSON text exactly as GET /data sent it, and its version.
    static func handOverArguments(json: String, version: Int) -> [String: Any] {
        ["json": json, "version": version]
    }

    /// Share sends the page as a file: once hand-overs moved the open page past the numbers in
    /// the HTML it loaded, GET /html first (the server serves the newest data).
    static func shareNeedsFetch(dataShown: Int?, htmlDataVersion: Int?) -> Bool {
        guard let inPage = htmlDataVersion else { return false }
        return (dataShown ?? 0) > inPage
    }

    // MARK: - Reading the HTML

    private static let lt = UInt8(ascii: "<"), gt = UInt8(ascii: ">")

    private static func scan(_ bytes: UnsafeBufferPointer<UInt8>) -> Int? {
        var i = 0
        let n = bytes.count
        while i < n {
            guard bytes[i] == lt else { i += 1; continue }
            if has(bytes, at: i + 1, "!--") {
                i = find(bytes, "-->", from: i + 4).map { $0 + 3 } ?? n
                continue
            }
            for raw in ["style", "script"] where has(bytes, at: i + 1, raw) && isNameEnd(bytes, at: i + 1 + raw.utf8.count) {
                guard let found = tag(bytes, from: i + 1 + raw.utf8.count) else { return nil }
                let (attributes, end) = found
                if raw == "script", attributes["id"] == ArtifactLiveData.elementId,
                   attributes["type"]?.lowercased() == "application/json" {
                    let value = attributes[ArtifactLiveData.versionAttribute] ?? ""
                    return max(0, Int(value.trimmingCharacters(in: .whitespaces)) ?? 0)
                }
                // Raw text: nothing inside is markup.
                i = find(bytes, "</" + raw, from: end) ?? n
                break
            }
            i += 1
        }
        return nil
    }

    /// The attributes of a start tag whose name ends at `start`, and where it ends; nil when the
    /// tag never closes. Names are lowercased; the first of a repeated name wins.
    private static func tag(_ bytes: UnsafeBufferPointer<UInt8>, from start: Int) -> ([String: String], Int)? {
        var attributes: [String: String] = [:]
        var j = start
        let n = bytes.count
        func skipSpace() { while j < n, isSpace(bytes[j]) || bytes[j] == UInt8(ascii: "/") { j += 1 } }
        while true {
            skipSpace()
            guard j < n else { return nil }
            if bytes[j] == gt { return (attributes, j + 1) }
            let nameStart = j
            while j < n, !isSpace(bytes[j]), bytes[j] != UInt8(ascii: "="), bytes[j] != gt, bytes[j] != UInt8(ascii: "/") { j += 1 }
            let name = String(decoding: UnsafeBufferPointer(rebasing: bytes[nameStart..<j]), as: UTF8.self).lowercased()
            while j < n, isSpace(bytes[j]) { j += 1 }
            var value = ""
            if j < n, bytes[j] == UInt8(ascii: "=") {
                j += 1
                while j < n, isSpace(bytes[j]) { j += 1 }
                guard j < n else { return nil }
                let quote = bytes[j]
                if quote == UInt8(ascii: "\"") || quote == UInt8(ascii: "'") {
                    let valueStart = j + 1
                    j = valueStart
                    while j < n, bytes[j] != quote { j += 1 }
                    guard j < n else { return nil }
                    value = String(decoding: UnsafeBufferPointer(rebasing: bytes[valueStart..<j]), as: UTF8.self)
                    j += 1
                } else {
                    let valueStart = j
                    while j < n, !isSpace(bytes[j]), bytes[j] != gt { j += 1 }
                    value = String(decoding: UnsafeBufferPointer(rebasing: bytes[valueStart..<j]), as: UTF8.self)
                }
            }
            if !name.isEmpty, attributes[name] == nil { attributes[name] = value }
        }
    }

    /// `word` (ASCII, matched case-blind) at `index`.
    private static func has(_ bytes: UnsafeBufferPointer<UInt8>, at index: Int, _ word: String) -> Bool {
        let utf8 = Array(word.utf8)
        guard index >= 0, index + utf8.count <= bytes.count else { return false }
        for (k, char) in utf8.enumerated() where lower(bytes[index + k]) != lower(char) { return false }
        return true
    }

    private static func find(_ bytes: UnsafeBufferPointer<UInt8>, _ word: String, from start: Int) -> Int? {
        guard let first = word.utf8.first else { return nil }
        var k = max(0, start)
        while k < bytes.count {
            if lower(bytes[k]) == lower(first), has(bytes, at: k, word) { return k }
            k += 1
        }
        return nil
    }

    private static func isNameEnd(_ bytes: UnsafeBufferPointer<UInt8>, at index: Int) -> Bool {
        guard index < bytes.count else { return false }
        return isSpace(bytes[index]) || bytes[index] == gt || bytes[index] == UInt8(ascii: "/")
    }

    private static func isSpace(_ byte: UInt8) -> Bool { byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0C || byte == 0x0D }

    private static func lower(_ byte: UInt8) -> UInt8 { (0x41...0x5A).contains(byte) ? byte + 0x20 : byte }

    /// A JS string literal of a fixed name.
    private static func literal(_ value: String) -> String {
        (try? JSONEncoder().encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
    }
}

/// M27: one GET /data in flight per artifact (both viewers of the same artifact share it). A
/// newer version asked for meanwhile is looked at again when it ends, so a burst of updates ends
/// in one more fetch, not one per update.
struct LiveDataFetches: Hashable, Sendable {
    /// in flight, with the newest version asked for
    private(set) var inFlight: [String: Int] = [:]
    /// asked for a newer version while in flight
    private(set) var again: Set<String> = []

    /// `id` is behind at `version`: true = start a fetch now.
    mutating func ask(_ id: String, version: Int) -> Bool {
        guard let asked = inFlight[id] else {
            inFlight[id] = version
            return true
        }
        if version > asked {
            inFlight[id] = version
            again.insert(id)
        }
        return false
    }

    /// The fetch for `id` ended (answered or failed): true = a newer version was asked for
    /// meanwhile, so look again.
    mutating func ended(_ id: String) -> Bool {
        inFlight[id] = nil
        return again.remove(id) != nil
    }
}
