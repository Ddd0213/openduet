// M16: "Decisions and updates" rows (TaskUpdateRules): the same server-built row in a row is one
// row with a count, approvals split into their line and a folded detail, the latest rows first.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Task updates: merged, folded and split (M16)")
struct DataTaskUpdateTests {
    private let base = Date(timeIntervalSince1970: 1_800_000_000)

    private func unreachable(_ minutes: Double, reason: String = "network error", source: String = "Claude") -> TaskUpdate {
        TaskUpdate(
            text: Phrase(key: "system.model_unreachable", params: ["reason": .text(reason)], text: nil),
            source: source, at: base.addingTimeInterval(minutes * 60)
        )
    }

    private func said(_ text: String, _ minutes: Double) -> TaskUpdate {
        TaskUpdate(text: Phrase(key: nil, params: nil, text: text), source: "Claude", at: base.addingTimeInterval(minutes * 60))
    }

    private func approval(_ summary: String) -> TaskUpdate {
        TaskUpdate(text: Phrase(key: "task.approval_done", params: ["summary": .text(summary)], text: nil), source: "Claude's computer", at: base)
    }

    @Test("the same failure again is one row: ×count, first time in since, latest in at")
    func mergesRuns() {
        let rows = TaskUpdateRules.merged([unreachable(0), unreachable(1), unreachable(22)])
        #expect(rows.count == 1)
        #expect(rows[0].count == 3)
        #expect(rows[0].since == base)
        #expect(rows[0].at == base.addingTimeInterval(22 * 60))
    }

    @Test("a different reason or source, OpenDuet's own text, or a row between keeps them apart")
    func keepsApart() {
        let rows = TaskUpdateRules.merged([
            unreachable(0), unreachable(1, reason: "timeout"), unreachable(2, reason: "timeout", source: "Gmail"),
            said("Tried again.", 3), said("Tried again.", 4), unreachable(5),
        ])
        #expect(rows.count == 6)
        #expect(rows.allSatisfy { $0.count == nil && $0.since == nil })
    }

    @Test("a row the server already merged keeps counting from its count and its first time")
    func continuesServerMerge() {
        var first = unreachable(10)
        first.count = 4
        first.since = base
        let rows = TaskUpdateRules.merged([first, unreachable(12)])
        #expect(rows.count == 1)
        #expect(rows[0].count == 5)
        #expect(rows[0].since == base)
    }

    @Test("only the latest 8 show until expanded, with how many are folded away")
    func folds() {
        let rows = (0..<12).map { said("Step \($0)", Double($0)) }
        let folded = TaskUpdateRules.shown(rows, expanded: false)
        #expect(folded.rows.count == TaskUpdateRules.visible)
        #expect(folded.hidden == 4)
        #expect(folded.rows.first == rows[4])
        let open = TaskUpdateRules.shown(rows, expanded: true)
        #expect(open.rows.count == 12)
        #expect(open.hidden == 0)
        #expect(TaskUpdateRules.shown(Array(rows.prefix(8)), expanded: false).hidden == 0)
    }

    @Test("an approval splits into its names and the folded command (the Command label dropped)")
    func splitsApproval() {
        let split = TaskUpdateRules.approval(approval("Claude's computer · Run commands: Command ls -la /workspace; echo \"---\"; find /workspace -maxdepth 3 | head -100"))
        #expect(split == TaskUpdateRules.Approval(parts: ["Claude's computer", "Run commands"], detail: "ls -la /workspace; echo \"---\"; find /workspace -maxdepth 3 | head -100"))
    }

    @Test("not an approval, or no detail after the colon: nothing to fold")
    func noSplit() {
        #expect(TaskUpdateRules.approval(unreachable(0)) == nil)
        #expect(TaskUpdateRules.approval(said("Note: done", 0)) == nil)
        #expect(TaskUpdateRules.approval(approval("Gmail · Send email")) == nil)
        #expect(TaskUpdateRules.approval(approval("Gmail · Send email: ")) == nil)
    }

    @Test("failures are told apart for the warning colour")
    func failures() {
        #expect(TaskUpdateRules.isFailure(unreachable(0)))
        #expect(TaskUpdateRules.isFailure(TaskUpdate(text: Phrase(key: "task.build_failed", params: nil, text: nil), source: "Claude", at: base)))
        #expect(!TaskUpdateRules.isFailure(approval("Gmail · Send email: to sam@example.com")))
        #expect(!TaskUpdateRules.isFailure(said("All good", 0)))
    }

    @Test("a merged row decodes count and since; an old row decodes without them")
    func decodes() throws {
        let decoder = JSONCoding.decoder()
        let merged = try decoder.decode(TaskUpdate.self, from: Data(#"{"text":{"key":"system.model_unreachable"},"source":"Claude","at":"2026-10-26T03:52:00Z","count":10,"since":"2026-10-26T03:30:00Z"}"#.utf8))
        #expect(merged.count == 10)
        #expect(merged.since != nil)
        let once = try decoder.decode(TaskUpdate.self, from: Data(#"{"text":{"text":"Hi"},"source":"Claude","at":"2026-10-26T03:52:00Z"}"#.utf8))
        #expect(once.count == nil && once.since == nil)
    }
}
