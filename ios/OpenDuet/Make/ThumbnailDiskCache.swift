// M24 (review-make P2-1): the gallery's live thumbnails kept on disk, so a cold start shows the
// pages it already drew instead of rendering every one again. One JPEG per artifact version and
// colour scheme in Caches/ArtifactThumbnails (excluded from backup): the name carries the id and
// updatedAt, so a new version misses and replaces the old one; least recently used files go once
// the folder passes ~50 MB; sign-out deletes the folder. Pure Foundation (host-tested).
import Foundation

/// One snapshot: an artifact version in one colour scheme.
struct ThumbnailKey: Hashable, Sendable {
    var artifactId: String
    var version: Date
    var dark: Bool

    /// The in-memory cache's key (as before M24).
    var memoryKey: String { "\(artifactId)|\(version.timeIntervalSince1970)|\(dark ? "d" : "l")" }

    /// "<id>_<updatedAt ms>_<d|l>.jpg"; the id is percent-escaped, so it never holds "_".
    var fileName: String { "\(Self.prefix(artifactId))\(Self.millis(version))_\(dark ? "d" : "l").jpg" }

    /// Every file of this artifact starts with this.
    static func prefix(_ artifactId: String) -> String { Self.escape(artifactId) + "_" }

    /// A file of the same artifact for another version (either scheme): it can go.
    func isOlderVersion(_ name: String) -> Bool {
        let prefix = Self.prefix(artifactId)
        guard name.hasPrefix(prefix) else { return false }
        return !name.dropFirst(prefix.count).hasPrefix("\(Self.millis(version))_")
    }

    static func millis(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }

    private static let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")

    static func escape(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: safe) ?? "x"
    }
}

extension ThumbnailKey {
    /// M27: the key of a file name (`fileName`'s format); nil for any other name.
    init?(fileName name: String) {
        guard name.hasSuffix(".jpg") else { return nil }
        let parts = name.dropLast(4).split(separator: "_", omittingEmptySubsequences: false)
        guard parts.count == 3, let millis = Int64(parts[1]), parts[2] == "d" || parts[2] == "l",
              let id = String(parts[0]).removingPercentEncoding, !id.isEmpty else { return nil }
        self.init(artifactId: id, version: Date(timeIntervalSince1970: Double(millis) / 1000), dark: parts[2] == "d")
    }

    /// M27: the newest version of `artifactId` in one scheme among `names` (a tile that scrolls
    /// back in, or a cold start, shows it while a data-only change waits).
    static func newest(_ artifactId: String, dark: Bool, in names: [String]) -> (key: ThumbnailKey, name: String)? {
        let prefix = Self.prefix(artifactId)
        var best: (key: ThumbnailKey, name: String, millis: Int64)?
        for name in names where name.hasPrefix(prefix) {
            guard let key = ThumbnailKey(fileName: name), key.artifactId == artifactId, key.dark == dark else { continue }
            let millis = Self.millis(key.version)
            if best.map({ millis > $0.millis }) ?? true { best = (key, name, millis) }
        }
        return best.map { ($0.key, $0.name) }
    }
}

enum ThumbnailTrim {
    struct Entry: Hashable, Sendable {
        var name: String
        var bytes: Int
        var lastUsed: Date
    }

    /// The least recently used files to delete so the rest fit in `limit` bytes.
    static func evictions(_ entries: [Entry], limit: Int) -> [String] {
        var total = entries.reduce(0) { $0 + $1.bytes }
        guard total > limit else { return [] }
        var out: [String] = []
        for entry in entries.sorted(by: { $0.lastUsed != $1.lastUsed ? $0.lastUsed < $1.lastUsed : $0.name < $1.name }) {
            guard total > limit else { break }
            out.append(entry.name)
            total -= entry.bytes
        }
        return out
    }
}

actor ThumbnailDiskCache {
    static let shared = ThumbnailDiskCache(folder: URL.cachesDirectory.appendingPathComponent("ArtifactThumbnails", isDirectory: true))

    /// ~50 MB (review-make P2-1).
    static let defaultLimit = 50 << 20

    let folder: URL
    let limit: Int
    /// Writes captured before the last `removeAll` (a render that finished after sign-out) are dropped.
    private var floor = 0

    init(folder: URL, limit: Int = ThumbnailDiskCache.defaultLimit) {
        self.folder = folder
        self.limit = limit
    }

    /// The JPEG for `key`, or nil; a hit counts as a use (least recently used goes first).
    func data(for key: ThumbnailKey) -> Data? {
        let url = folder.appendingPathComponent(key.fileName)
        guard let data = try? Data(contentsOf: url) else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return data
    }

    /// M27: the newest snapshot of `artifactId` in one scheme, whatever its version, with its key;
    /// a hit counts as a use.
    func newest(_ artifactId: String, dark: Bool) -> (key: ThumbnailKey, data: Data)? {
        guard let found = ThumbnailKey.newest(artifactId, dark: dark, in: names()) else { return nil }
        let url = folder.appendingPathComponent(found.name)
        guard let data = try? Data(contentsOf: url) else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return (found.key, data)
    }

    /// Saves one snapshot, deletes the artifact's older versions and trims to the limit.
    /// `generation`: the caller's count of sign-outs when the render started.
    func store(_ data: Data, for key: ThumbnailKey, generation: Int = 0) {
        guard generation >= floor, prepareFolder() else { return }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        for name in names where key.isOlderVersion(name) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
        try? data.write(to: folder.appendingPathComponent(key.fileName), options: .atomic)
        trim()
    }

    /// Sign-out: every snapshot goes; writes from before it (`generation` below) are ignored.
    func removeAll(generation: Int = 0) {
        floor = max(floor, generation)
        try? FileManager.default.removeItem(at: folder)
    }

    /// The JPEG names on disk (tests).
    func names() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).filter { $0.hasSuffix(".jpg") }.sorted()
    }

    private func trim() {
        let entries: [ThumbnailTrim.Entry] = names().compactMap { name in
            let path = folder.appendingPathComponent(name).path
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else { return nil }
            let bytes = (attributes[.size] as? NSNumber)?.intValue ?? 0
            let used = attributes[.modificationDate] as? Date ?? .distantPast
            return ThumbnailTrim.Entry(name: name, bytes: bytes, lastUsed: used)
        }
        for name in ThumbnailTrim.evictions(entries, limit: limit) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
    }

    /// The folder exists and is left out of backups (it holds page content).
    private func prepareFolder() -> Bool {
        if !FileManager.default.fileExists(atPath: folder.path) {
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            } catch {
                return false
            }
            var url = folder
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
        }
        return true
    }
}
