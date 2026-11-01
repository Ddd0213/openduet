// M8 UI rules: the composer's ↑ (any text, an uncommitted pinyin candidate included), the quote
// excerpt, and approval cards' phase + fold (the success moment, then one summary line; cards
// already settled when the thread loads start folded).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Composer and approval fold")
struct UIComposerApprovalTests {
    @Test("↑ shows for any text, a marked (pinyin) candidate alone included, or an upload")
    func composerSend() {
        #expect(!ComposerRules.showsSend(committed: "", hasMarkedText: false, hasUploads: false), "waveform")
        #expect(!ComposerRules.showsSend(committed: "  \n", hasMarkedText: false, hasUploads: false))
        #expect(ComposerRules.showsSend(committed: "", hasMarkedText: true, hasUploads: false), "typing nihao before committing")
        #expect(ComposerRules.showsSend(committed: "Hi", hasMarkedText: false, hasUploads: false))
        #expect(ComposerRules.showsSend(committed: "", hasMarkedText: false, hasUploads: true))
        #expect(!ComposerRules.canSend(committed: "Hi", hasMarkedText: false, hasUploads: false, attachmentsReady: false), "an upload still running")
        #expect(ComposerRules.canSend(committed: "", hasMarkedText: true, hasUploads: false, attachmentsReady: true))
        // ↑ while composing: the committed candidate and everything visible go, trimmed.
        #expect(ComposerRules.outgoingText(committed: "我想", visible: "我想去 ") == "我想去")
        #expect(ComposerRules.outgoingText(committed: " Hi ", visible: nil) == "Hi")
    }

    @Test("Quote excerpt: one line, at most 160 characters")
    func excerpt() {
        #expect(ReplyExcerpt.make("Here are\n\nthree   options") == "Here are three options")
        let long = String(repeating: "a", count: 200)
        let cut = ReplyExcerpt.make(long)
        #expect(cut.count == ReplyExcerpt.limit)
        #expect(cut.hasSuffix("…"))
        #expect(ReplyExcerpt.make(String(repeating: "b", count: 160)).count == 160, "exactly 160 stays whole")
    }

    private func approval(_ status: String, ok: Bool = true, expiresIn: Int? = nil) -> Approval {
        var json = Fx.approvalJSON(status: status)
        if status == "approved" { json["result"] = ["ok": ok, "error": ok ? NSNull() as Any : ["text": "Gmail said no"] as [String: Any]] }
        if let expiresIn { json["expiresAt"] = Fx.iso(expiresIn) }
        return Fx.decode(Approval.self, json)
    }

    @Test("Phase from the approval, the tap in flight and the clock")
    func phase() {
        let now = Fx.date(100)
        #expect(ApprovalPhase(approval: approval("pending"), request: nil, now: now) == .pending)
        #expect(ApprovalPhase(approval: approval("pending"), request: .inFlight, now: now) == .busy)
        #expect(ApprovalPhase(approval: approval("pending"), request: .failed(reason: "Offline"), now: now) == .failed(reason: "Offline", phrase: nil))
        #expect(ApprovalPhase(approval: approval("pending", expiresIn: 50), request: nil, now: now) == .expired, "past expiresAt")
        #expect(ApprovalPhase(approval: approval("approved"), request: nil, now: now) == .done)
        #expect(ApprovalPhase(approval: approval("approved", ok: false), request: nil, now: now).isFailed)
        #expect(ApprovalPhase(approval: approval("declined"), request: nil, now: now) == .declined)
        #expect(ApprovalPhase(approval: approval("expired"), request: nil, now: now) == .expired)
        #expect(ApprovalPhase.done.isSettled && ApprovalPhase.declined.isSettled)
        #expect(!ApprovalPhase.expired.isSettled && !ApprovalPhase.pending.isSettled)
    }

    @Test("Fold: settled cards mount folded; a live success celebrates ~1.2 s, then folds; a tap toggles")
    func fold() {
        #expect(ApprovalFold.start(.done) == .folded, "already done when the thread loads")
        #expect(ApprovalFold.start(.declined) == .folded)
        #expect(ApprovalFold.start(.pending) == .open)
        #expect(ApprovalFold.start(.expired) == .open, "expired keeps Ask again in view")
        #expect(ApprovalFold.start(.failed(reason: "x", phrase: nil)) == .open)

        #expect(ApprovalFold.celebrationSeconds == 1.2)
        let celebrating = ApprovalFold.open.next(after: .done)
        #expect(celebrating == .celebrating, "the green check draws in place first")
        #expect(!celebrating.isFolded)
        #expect(celebrating.afterCelebration == .folded)
        #expect(ApprovalFold.folded.next(after: .done) == .folded, "no replay for a card already folded")
        #expect(ApprovalFold.open.next(after: .declined) == .folded, "Not now folds at once")
        #expect(ApprovalFold.folded.next(after: .pending) == .open, "asked again: the card opens")
        #expect(ApprovalFold.open.afterCelebration == .open)
        #expect(ApprovalFold.folded.toggled == .open)
        #expect(ApprovalFold.open.toggled == .folded)
    }
}
