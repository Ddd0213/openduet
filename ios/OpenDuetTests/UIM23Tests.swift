// M23 W5 rules: the quick-reply card's rows (live, chosen = bold + ✓, the rest faded; an earlier
// turn's faded), the suggestion swipe (thresholds, flicks, direction, blur / wash, the stack
// rising), which Up next suggestion floats above the composer (newest, not one an open card
// shows, the channel's, at most 3) and when it hides, its source line, when the store asks
// GET /api/up-next again and which rows a card answered, an approval's "why" and when it offers
// the fainter Always row.
import CoreGraphics
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private enum M23Fx {
    static let base = Date(timeIntervalSince1970: 1_792_368_000)

    static func suggestion(_ id: String, minutes: Double, channel: String? = nil, app: String? = nil,
                           fromUser: Bool? = nil, source: SourceRef? = nil) -> Suggestion {
        Suggestion(id: id, channelId: channel, title: "Title \(id)", body: "", app: app, origin: .checkin,
                   createdAt: base.addingTimeInterval(minutes * 60), fromUser: fromUser, sourceRef: source)
    }

    static func message(_ id: String, _ content: MessageContent) -> Message {
        Message(id: id, channelId: "main", taskId: nil, role: .assistant, text: "", status: .sent, clientId: nil,
                reactions: [], createdAt: base, updatedAt: base, content: content)
    }

    static func card(_ id: String, _ state: ProactiveSuggestionPayload.State, suggestion: String?) -> Message {
        message(id, .proactiveSuggestion(ProactiveSuggestionPayload(
            title: "T", body: "B", prompt: "P", state: state, taskId: state == .started ? "task_1" : nil, suggestionId: suggestion
        )))
    }

    static func items(_ id: String, _ items: [(suggestion: String?, started: Bool)]) -> Message {
        message(id, .taskSuggestions(TaskSuggestionsPayload(items: items.enumerated().map { index, item in
            TaskSuggestionsPayload.Item(id: "i\(index)", title: "T", prompt: "P", app: nil,
                                        taskId: item.started ? "task_\(index)" : nil, suggestionId: item.suggestion)
        })))
    }

    static func task(_ id: String) -> TaskSummary {
        TaskSummary(id: id, channelId: "main", title: "T", status: .working, source: .user, latestUpdate: nil,
                    updateCount: 0, schedule: nil, archived: false, createdAt: base, updatedAt: base)
    }

    static func approval(_ kind: ApprovalKind, _ preview: ApprovalPreview, status: ApprovalStatus = .pending,
                         why: Phrase? = nil, always: ApprovalAlways? = nil) -> Approval {
        Approval(id: "apr", kind: kind, status: status, version: 1, preview: preview, expiresAt: nil, taskId: nil,
                 messageId: "m", result: nil, changedFields: [], why: why, always: always, updatedAt: base)
    }

    static func action(_ app: String, browser: BrowserAction? = nil) -> ApprovalPreview {
        .action(ActionPreview(app: app, toolName: "Create event", rows: [], browser: browser))
    }

    static let email = ApprovalPreview.email(EmailPreview(app: "Gmail", to: ["sam@example.com"], cc: [], subject: "Hi", body: "Hi", attachments: []))
    static let payment = ApprovalPreview.payment(PaymentPreview(amount: 1200, currency: "USD", merchant: "Shop", description: "", testMode: true))
    static let delete = ApprovalPreview.delete(RowsPreview(app: "Google Drive", title: "Q4.pdf", rows: []))
    static let sign = ApprovalPreview.sign(RowsPreview(app: "DocuSign", title: "NDA", rows: []))
    static let recipient = ApprovalAlways(scope: .recipient, value: "sam@example.com", category: nil)

    static func browser(_ category: BrowserAction.Category) -> BrowserAction {
        BrowserAction(site: "forum.example.org", button: "Post", category: category, via: .click)
    }

    static func site(_ category: BrowserAction.Category) -> ApprovalAlways {
        ApprovalAlways(scope: .site, value: "forum.example.org", category: category)
    }
}

@Suite("M23 quick-reply card")
struct UIM23QuickReplyTests {
    @Test("before a choice every row is live; the chosen one is bold with a ✓, the others fade")
    func chosen() {
        #expect(QuickReplyRules.row("Yes", chosen: nil, stale: false) == .live)
        #expect(QuickReplyRules.row("No", chosen: nil, stale: false) == .live)
        #expect(QuickReplyRules.row("Yes", chosen: "Yes", stale: false) == .chosen)
        #expect(QuickReplyRules.row("No", chosen: "Yes", stale: false) == .faded)
        #expect(!QuickReplyRules.isLocked(chosen: nil, stale: false))
        #expect(QuickReplyRules.isLocked(chosen: "Yes", stale: false), "a choice locks every row; the card stays")
    }

    @Test("an earlier turn's options fade and lock; its choice still shows; an unknown choice fades all")
    func staleAndUnknown() {
        #expect(QuickReplyRules.row("Yes", chosen: nil, stale: true) == .faded)
        #expect(QuickReplyRules.isLocked(chosen: nil, stale: true))
        #expect(QuickReplyRules.row("Yes", chosen: "Yes", stale: true) == .chosen, "reading back shows what was picked")
        #expect(QuickReplyRules.row("No", chosen: "Yes", stale: true) == .faded)
        #expect(QuickReplyRules.row("Yes", chosen: "Something else", stale: false) == .faded)
        #expect(QuickReplyRules.fadedOpacity < 0.5)
    }
}

@Suite("M23 suggestion swipe")
struct UIM23SwipeTests {
    @Test("the threshold is 35% of the card, at least 96 pt")
    func threshold() {
        #expect(SuggestionSwipe.threshold(width: 200) == 96)
        #expect(abs(SuggestionSwipe.threshold(width: 360) - 126) < 0.001)
    }

    @Test("past the threshold: right starts, left hides (or snaps back without Hide); short drags snap back")
    func outcomes() {
        #expect(SuggestionSwipe.outcome(dx: 130, dy: 0, predictedDx: 130, width: 360) == .start)
        #expect(SuggestionSwipe.outcome(dx: 120, dy: 0, predictedDx: 120, width: 360) == .cancel)
        #expect(SuggestionSwipe.outcome(dx: -130, dy: 0, predictedDx: -130, width: 360) == .hide)
        #expect(SuggestionSwipe.outcome(dx: -130, dy: 0, predictedDx: -130, width: 360, allowsHide: false) == .cancel)
        #expect(SuggestionSwipe.outcome(dx: 96, dy: 0, predictedDx: 96, width: 200) == .start, "exactly the threshold")
    }

    @Test("a quick flick answers from a shorter drag, in its own direction only")
    func flicks() {
        #expect(SuggestionSwipe.outcome(dx: 50, dy: 0, predictedDx: 300, width: 360) == .start)
        #expect(SuggestionSwipe.outcome(dx: -50, dy: 0, predictedDx: -300, width: 360) == .hide)
        #expect(SuggestionSwipe.outcome(dx: 30, dy: 0, predictedDx: 400, width: 360) == .cancel, "too short to be a flick")
        #expect(SuggestionSwipe.outcome(dx: 50, dy: 0, predictedDx: 200, width: 360) == .cancel, "not thrown far enough")
        #expect(SuggestionSwipe.outcome(dx: 50, dy: 0, predictedDx: -300, width: 360) == .cancel, "thrown back the other way")
    }

    @Test("a mostly vertical drag is a scroll, never a swipe")
    func direction() {
        #expect(SuggestionSwipe.isHorizontal(dx: 40, dy: 10))
        #expect(!SuggestionSwipe.isHorizontal(dx: 40, dy: 40))
        #expect(SuggestionSwipe.outcome(dx: 130, dy: 120, predictedDx: 400, width: 360) == .cancel)
    }

    @Test("blur and wash grow with the drag and stop at their maximum; Reduce Motion never blurs")
    func blurAndWash() {
        #expect(abs(SuggestionSwipe.progress(dx: 63, width: 360) - 0.5) < 0.001)
        #expect(SuggestionSwipe.progress(dx: -500, width: 360) == 1)
        #expect(SuggestionSwipe.blur(0, reduceMotion: false) == 0)
        #expect(SuggestionSwipe.blur(0.5, reduceMotion: false) == SuggestionSwipe.maxBlur / 2)
        #expect(SuggestionSwipe.blur(2, reduceMotion: false) == SuggestionSwipe.maxBlur)
        #expect(SuggestionSwipe.blur(1, reduceMotion: true) == 0)
        #expect(SuggestionSwipe.wash(0) == 0)
        #expect(SuggestionSwipe.wash(0.5) < SuggestionSwipe.wash(1))
        #expect(SuggestionSwipe.wash(1) == SuggestionSwipe.maxWash)
    }

    @Test("the cards under the top one peek out smaller and rise and grow into place as it leaves")
    func stack() {
        #expect(SuggestionSwipe.stackOffset(depth: 0, lift: 0.3, reduceMotion: false) == 0)
        #expect(SuggestionSwipe.stackScale(depth: 0, lift: 0.3, reduceMotion: false) == 1)
        #expect(SuggestionSwipe.stackOffset(depth: 1, lift: 0, reduceMotion: false) == SuggestionSwipe.peek)
        #expect(SuggestionSwipe.stackScale(depth: 1, lift: 0, reduceMotion: false) == 1 - SuggestionSwipe.peekScale)
        #expect(SuggestionSwipe.stackOffset(depth: 1, lift: 1, reduceMotion: false) == 0, "the next one takes the top's place")
        #expect(SuggestionSwipe.stackScale(depth: 1, lift: 1, reduceMotion: false) == 1)
        #expect(SuggestionSwipe.stackOffset(depth: 2, lift: 1, reduceMotion: false) == SuggestionSwipe.peek)
        #expect(SuggestionSwipe.stackOffset(depth: 1, lift: 1, reduceMotion: true) == SuggestionSwipe.peek, "Reduce Motion: no movement")
        #expect(SuggestionSwipe.stackScale(depth: 1, lift: 1, reduceMotion: true) == 1 - SuggestionSwipe.peekScale)
    }
}

@Suite("M23 Up next above the composer")
struct UIM23ComposerSuggestionTests {
    @Test("newest first, at most 3; equal times keep the server's order")
    func newestFirst() {
        let list = [
            M23Fx.suggestion("a", minutes: 1), M23Fx.suggestion("b", minutes: 5),
            M23Fx.suggestion("c", minutes: 3), M23Fx.suggestion("d", minutes: 2), M23Fx.suggestion("e", minutes: 5),
        ]
        let stack = ComposerSuggestionRules.stack(list, thread: [], channelId: nil)
        #expect(stack.map(\.id) == ["b", "e", "c"])
        #expect(ComposerSuggestionRules.stack([], thread: [], channelId: nil).isEmpty)
    }

    @Test("not one an open card in this thread already shows; a started or hidden card doesn't count")
    func notTwice() {
        let list = [M23Fx.suggestion("sug_23", minutes: 9), M23Fx.suggestion("sug_25", minutes: 8), M23Fx.suggestion("sug_26", minutes: 7)]
        let thread = [
            M23Fx.card("m1", .open, suggestion: "sug_23"),
            M23Fx.items("m2", [(suggestion: "sug_25", started: false), (suggestion: "sug_24", started: true)]),
            M23Fx.card("m3", .hidden, suggestion: "sug_26"),
            M23Fx.card("m4", .open, suggestion: nil),
        ]
        #expect(ComposerSuggestionRules.openCardSuggestionIds(thread) == ["sug_23", "sug_25"])
        #expect(ComposerSuggestionRules.stack(list, thread: thread, channelId: nil).map(\.id) == ["sug_26"])
    }

    @Test("Everything shows every channel's; a channel its own and the unscoped ones")
    func scope() {
        let list = [
            M23Fx.suggestion("a", minutes: 3, channel: "ch_1"), M23Fx.suggestion("b", minutes: 2, channel: "ch_2"),
            M23Fx.suggestion("c", minutes: 1, channel: nil),
        ]
        #expect(ComposerSuggestionRules.stack(list, thread: [], channelId: nil).map(\.id) == ["a", "b", "c"])
        #expect(ComposerSuggestionRules.stack(list, thread: [], channelId: "ch_1").map(\.id) == ["a", "c"])
        var state = ShellState()
        state.tasks.upNext.suggestions = list
        state.threadChannelId = "ch_2"
        #expect(ComposerUpNext(state: state).stack.map(\.id) == ["a", "b", "c"], "the main thread")
        state.thread.context = .channel(name: "design")
        #expect(ComposerUpNext(state: state).stack.map(\.id) == ["b", "c"])
    }

    @Test("it gives way while the user writes: focus, text, an attachment, a quote, the skills list")
    func visibility() {
        #expect(ComposerSuggestionRules.isVisible(hasContent: false, focused: false, hasAttachments: false, quoting: false, pickingSkill: false))
        #expect(!ComposerSuggestionRules.isVisible(hasContent: false, focused: true, hasAttachments: false, quoting: false, pickingSkill: false))
        #expect(!ComposerSuggestionRules.isVisible(hasContent: true, focused: false, hasAttachments: false, quoting: false, pickingSkill: false))
        #expect(!ComposerSuggestionRules.isVisible(hasContent: false, focused: false, hasAttachments: true, quoting: false, pickingSkill: false))
        #expect(!ComposerSuggestionRules.isVisible(hasContent: false, focused: false, hasAttachments: false, quoting: true, pickingSkill: false))
        #expect(!ComposerSuggestionRules.isVisible(hasContent: false, focused: false, hasAttachments: false, quoting: false, pickingSkill: true))
    }

    @Test("the source line: the email or event, else the app; \"You asked\" for one saved by the user")
    func source() {
        let ref = SourceRef(app: "Gmail", kind: .email, title: "Re: Q4 budget")
        #expect(ComposerSuggestionRules.sourceLine(M23Fx.suggestion("a", minutes: 0, app: "Gmail", source: ref)) == "From Gmail · Re: Q4 budget")
        #expect(ComposerSuggestionRules.sourceLine(M23Fx.suggestion("a", minutes: 0, app: "Google Calendar")) == "From Google Calendar")
        let blank = SourceRef(app: " ", kind: .event, title: "  ")
        #expect(ComposerSuggestionRules.sourceLine(M23Fx.suggestion("a", minutes: 0, app: "Google Calendar", source: blank)) == "From Google Calendar")
        #expect(ComposerSuggestionRules.sourceLine(M23Fx.suggestion("a", minutes: 0)) == nil)
        let chat = SourceRef(app: nil, kind: .chat, title: "Lunch plans")
        #expect(ComposerSuggestionRules.sourceLine(M23Fx.suggestion("a", minutes: 0, source: chat)) == nil, "no app: nothing to name")
        #expect(ComposerSuggestionRules.sourceLine(M23Fx.suggestion("a", minutes: 0, app: "Gmail", fromUser: true, source: ref)) == "You asked")
    }

    @Test("GET /api/up-next again for suggestion cards, unknown tasks, a run's end, deletes; not for text")
    func refresh() {
        let known: (String) -> Bool = { $0 == "task_known" }
        #expect(UpNextRefresh.isRelevant(.message(M23Fx.card("m", .open, suggestion: "s")), knowsTask: known))
        #expect(UpNextRefresh.isRelevant(.message(M23Fx.items("m", [(suggestion: "s", started: false)])), knowsTask: known))
        #expect(!UpNextRefresh.isRelevant(.message(M23Fx.message("m", .text(TextPayload(skill: nil, attachments: [])))), knowsTask: known))
        #expect(UpNextRefresh.isRelevant(.task(M23Fx.task("task_new")), knowsTask: known))
        #expect(!UpNextRefresh.isRelevant(.task(M23Fx.task("task_known")), knowsTask: known), "status ticks of a known task")
        #expect(UpNextRefresh.isRelevant(Fx.done(1, run: "r").body, knowsTask: known))
        #expect(UpNextRefresh.isRelevant(.taskDeleted(taskId: "t"), knowsTask: known))
        #expect(!UpNextRefresh.isRelevant(Fx.typing(1, run: "r", true).body, knowsTask: known))
    }

    @Test("a card answered elsewhere takes its Up next rows away")
    func answered() {
        #expect(UpNextRefresh.answeredIds(.message(M23Fx.card("m", .started, suggestion: "s1"))) == ["s1"])
        #expect(UpNextRefresh.answeredIds(.message(M23Fx.card("m", .hidden, suggestion: "s1"))) == ["s1"])
        #expect(UpNextRefresh.answeredIds(.message(M23Fx.card("m", .open, suggestion: "s1"))).isEmpty)
        #expect(UpNextRefresh.answeredIds(.message(M23Fx.card("m", .started, suggestion: nil))).isEmpty, "an older card")
        let items = M23Fx.items("m", [(suggestion: "s1", started: true), (suggestion: "s2", started: false), (suggestion: nil, started: true)])
        #expect(UpNextRefresh.answeredIds(.message(items)) == ["s1"])
        #expect(UpNextRefresh.answeredIds(.task(M23Fx.task("t"))).isEmpty)
    }
}

@Suite("M23 approval why and Always")
struct UIM23ApprovalTests {
    @Test("the server's reason wins on any card, decided ones too")
    func serverWhy() {
        let why = Phrase(key: "approval.why_send")
        let card = M23Fx.approval(.action, M23Fx.action("OpenDuet's computer", browser: M23Fx.browser(.send)), why: why)
        #expect(ApprovalWhyRules.why(card) == .server(why))
        let decided = M23Fx.approval(.email, M23Fx.email, status: .approved, why: why)
        #expect(ApprovalWhyRules.why(decided) == .server(why))
    }

    @Test("otherwise the card says it from its own fields while it waits")
    func derivedWhy() {
        #expect(ApprovalWhyRules.why(M23Fx.approval(.email, M23Fx.email)) == .derived("It sends an email in your name."))
        #expect(ApprovalWhyRules.derived(M23Fx.payment) == "It moves money. Payments always ask.")
        #expect(ApprovalWhyRules.derived(M23Fx.sign) == "It signs something in your name.")
        #expect(ApprovalWhyRules.derived(M23Fx.delete) == "It deletes something, and that can't be undone.")
        #expect(ApprovalWhyRules.derived(M23Fx.action("Google Calendar")) == "It changes something in Google Calendar.")
        #expect(ApprovalWhyRules.derived(M23Fx.action("Slack"), always: M23Fx.recipient) == "It sends something to other people.")
        #expect(ApprovalWhyRules.derived(M23Fx.action("OpenDuet's computer")) == "It changes something on OpenDuet's computer.")
        #expect(ApprovalWhyRules.derived(M23Fx.action("/meeting-notes")) == "It runs a script on OpenDuet's computer.")
        #expect(ApprovalWhyRules.derived(M23Fx.action("  ")) == "It changes something outside this chat.")
        #expect(ApprovalWhyRules.derived(M23Fx.action("OpenDuet's computer", browser: M23Fx.browser(.send))) == nil, "the server explains clicks")
        #expect(ApprovalWhyRules.why(M23Fx.approval(.email, M23Fx.email, status: .approved)) == nil, "a decided card needs no reason")
        #expect(ApprovalWhyRules.why(M23Fx.approval(.email, M23Fx.email, status: .declined)) == nil)
    }

    @Test("the fainter Always row only for low-risk kinds that offer an exact Always")
    func always() {
        #expect(ApprovalWhyRules.showsAlways(M23Fx.approval(.email, M23Fx.email, always: M23Fx.recipient)))
        #expect(ApprovalWhyRules.showsAlways(M23Fx.approval(.action, M23Fx.action("Slack"), always: M23Fx.recipient)))
        #expect(ApprovalWhyRules.showsAlways(M23Fx.approval(.action, M23Fx.action("OpenDuet's computer", browser: M23Fx.browser(.send)), always: M23Fx.site(.send))))
        #expect(ApprovalWhyRules.showsAlways(M23Fx.approval(.action, M23Fx.action("OpenDuet's computer", browser: M23Fx.browser(.submit)), always: M23Fx.site(.submit))))
        #expect(!ApprovalWhyRules.showsAlways(M23Fx.approval(.action, M23Fx.action("OpenDuet's computer", browser: M23Fx.browser(.delete)), always: M23Fx.site(.delete))), "deletes always ask")
        #expect(!ApprovalWhyRules.showsAlways(M23Fx.approval(.action, M23Fx.action("OpenDuet's computer", browser: M23Fx.browser(.purchase)), always: M23Fx.site(.purchase))))
        #expect(!ApprovalWhyRules.showsAlways(M23Fx.approval(.payment, M23Fx.payment, always: M23Fx.recipient)))
        #expect(!ApprovalWhyRules.showsAlways(M23Fx.approval(.delete, M23Fx.delete, always: M23Fx.recipient)))
        #expect(!ApprovalWhyRules.showsAlways(M23Fx.approval(.sign, M23Fx.sign, always: M23Fx.recipient)))
        #expect(!ApprovalWhyRules.showsAlways(M23Fx.approval(.email, M23Fx.email)), "no Always offered")
        let unknown = ApprovalAlways(scope: .unknown, value: "x", category: nil)
        #expect(!ApprovalWhyRules.showsAlways(M23Fx.approval(.action, M23Fx.action("Slack"), always: unknown)))
    }
}
