// A call's transcript as the phone hears it: the providers' transcription pieces assembled into
// one CallLine per utterance (a stable id each, made when the utterance starts), the open ones
// shown as captions while they grow, and the finished ones queued for POST /lines (or the
// `lines` of /tool and /end). Pure Foundation (host-tested).
import Foundation

struct CallTranscript: Sendable {
    /// The most lines one request carries (contract: lines ≤ 100) and one line's longest text.
    static let batchLimit = 100
    static let textLimit = 4000

    /// Every utterance so far, oldest first; an open one grows in place (the captions).
    private(set) var lines: [CallLine] = []
    /// Finished lines the server hasn't been sent yet, oldest first.
    private(set) var unsent: [CallLine] = []
    /// The index in `lines` of the utterance still being spoken, per side.
    private var open: [CallLine.From: Int] = [:]
    private let makeId: @Sendable () -> String

    init(makeId: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }) {
        self.makeId = makeId
    }

    /// Whether this side has an utterance still being spoken.
    func isOpen(_ from: CallLine.From) -> Bool { open[from] != nil }

    /// A piece of what `from` says, added to their open utterance (a new one when there's none).
    mutating func add(_ from: CallLine.From, _ piece: String, at date: Date) {
        guard !piece.isEmpty else { return }
        if let index = open[from] {
            lines[index].text += piece
        } else {
            open[from] = lines.count
            lines.append(CallLine(id: makeId(), from: from, text: piece, at: date))
        }
    }

    /// The whole utterance (StepFun's `done` / `completed`): replaces the open one's text and
    /// finishes it, keeping its id.
    mutating func complete(_ from: CallLine.From, _ text: String, at date: Date) {
        if let index = open[from] {
            lines[index].text = text
        } else {
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            open[from] = lines.count
            lines.append(CallLine(id: makeId(), from: from, text: text, at: date))
        }
        finish(from)
    }

    /// Ends `from`'s open utterance: queued for the server, or dropped when nothing was said.
    mutating func finish(_ from: CallLine.From) {
        guard let index = open.removeValue(forKey: from) else { return }
        let text = String(lines[index].text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.textLimit))
        if text.isEmpty {
            lines.remove(at: index)
            for (side, other) in open where other > index { open[side] = other - 1 }
            return
        }
        lines[index].text = text
        unsent.append(lines[index])
    }

    mutating func finishAll() {
        finish(.user)
        finish(.voice)
    }

    /// Drops `from`'s open utterance without sending it (the voice's own echo, an answer to it
    /// that never played).
    mutating func drop(_ from: CallLine.From) {
        guard let index = open.removeValue(forKey: from) else { return }
        lines.remove(at: index)
        for (side, other) in open where other > index { open[side] = other - 1 }
    }

    /// What `from` is saying right now (nil when nothing is open).
    func openText(_ from: CallLine.From) -> String? { open[from].map { lines[$0].text } }

    /// The newest `count` utterances of `from` (the open one too), newest first.
    func recent(_ from: CallLine.From, _ count: Int) -> [String] {
        Array(lines.reversed().lazy.filter { $0.from == from }.prefix(count).map(\.text))
    }

    /// Takes up to `limit` unsent lines, oldest first, to send.
    mutating func take(_ limit: Int = Self.batchLimit) -> [CallLine] {
        let batch = Array(unsent.prefix(limit))
        unsent.removeFirst(batch.count)
        return batch
    }

    /// A batch that didn't go out goes back in front, in order (without doubles).
    mutating func putBack(_ batch: [CallLine]) {
        let queued = Set(unsent.map(\.id))
        unsent.insert(contentsOf: batch.filter { !queued.contains($0.id) }, at: 0)
    }

    /// The captions: the newest voice line and the newest user line, oldest first.
    var captions: [CallLine] {
        var picked: [CallLine] = []
        var sides = Set<CallLine.From>()
        for line in lines.reversed() where sides.insert(line.from).inserted {
            picked.insert(line, at: 0)
            if sides.count == 2 { break }
        }
        return picked
    }
}

/// What the user said over the voice, judged before it cuts anything: the voice's own echo (the
/// loudspeaker leaks into the microphone past the echo cancellation and StepFun's VAD and ASR take
/// it for the user: "让我先看看 OpenDuet…" came back as "那我先看看"), unsure (two or three
/// characters found in the voice's words: its echo or the user's answer, "不要" in "要不要…"), a
/// filler or a backchannel ("嗯", "好的", "ok"), or words (a barge-in). Unsure and filler: the
/// voice carries on and nothing is thrown away.
enum EchoCheck {
    enum Verdict: String, Hashable, Sendable {
        case echo, unsure, filler, words
    }

    /// How close 4+ heard characters must be to some stretch of the voice's to be its echo (1 −
    /// the edits per character).
    static let echoSimilarity = 0.7
    /// The heard text's characters compared (an echo is a short piece) and the voice's (its newest).
    static let heardLimit = 80
    static let voiceLimit = 1200

    static func verdict(_ heard: String, voice: [String]) -> Verdict {
        let needle = normalized(heard)
        guard !needle.isEmpty else { return .filler }
        let best = needle.count >= 2 ? (voice.lazy.map { similarity(needle, within: normalized($0)) }.max() ?? 0) : 0
        if needle.count >= 4, best >= echoSimilarity { return .echo }
        if isFiller(heard, needle) { return .filler }
        if needle.count >= 2, best >= 1 { return .unsure }
        return .words
    }

    /// 1 − the fewest edits that turn `needle` into some stretch of `haystack`, per character of
    /// `needle` (approximate substring matching: the stretch may start and end anywhere).
    static func similarity(_ needle: [UInt32], within haystack: [UInt32]) -> Double {
        let needle = Array(needle.prefix(heardLimit))
        let haystack = Array(haystack.suffix(voiceLimit))
        guard !needle.isEmpty, !haystack.isEmpty else { return 0 }
        // Column by column over the haystack: row i = edits for the needle's first i characters.
        var column = Array(0...needle.count)
        var best = column[needle.count]
        for h in haystack {
            var diagonal = column[0]
            column[0] = 0
            for i in 1...needle.count {
                let above = column[i]
                column[i] = min(diagonal + (needle[i - 1] == h ? 0 : 1), above + 1, column[i - 1] + 1)
                diagonal = above
            }
            best = min(best, column[needle.count])
        }
        return 1 - Double(best) / Double(needle.count)
    }

    /// Letters and digits only, lower-cased (punctuation, spaces and case don't count).
    static func normalized(_ text: String) -> [UInt32] {
        text.lowercased().unicodeScalars
            .filter { $0.properties.isAlphabetic || $0.properties.numericType != nil }
            .map(\.value)
    }

    private static let fillerCharacters = Set("嗯啊哦呃额噢唔哼哈呀嘛吧啦呢的诶欸哎嘿好对是行恩昂喔嗷".unicodeScalars.map(\.value))
    private static let fillerWords: Set<String> = [
        "um", "uh", "uhm", "erm", "er", "hmm", "hm", "mm", "mhm", "mmhm", "ah", "oh", "eh",
        "ok", "okay", "yeah", "yep", "yes", "right", "sure", "huh", "uhhuh",
    ]

    private static func isFiller(_ heard: String, _ needle: [UInt32]) -> Bool {
        if needle.count <= 6, needle.allSatisfy(fillerCharacters.contains) { return true }
        let words = heard.lowercased()
            .split { !$0.isLetter && $0 != "'" }
            .map { $0.replacingOccurrences(of: "'", with: "") }
        return !words.isEmpty && words.count <= 3 && words.allSatisfy(fillerWords.contains)
    }
}
