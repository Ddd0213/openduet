// The form card's rules (Chat/Cards/FormLogic.swift, M9 contract §2): taps on single / multi /
// Other, what counts as answered, the [FormAnswer] the app submits, the "label: answer"
// summary, submit-on-tap and the submitted card's draft. Also the Usage panel's numbers
// (Account/UsageMath.swift: share, model order, kind tiles).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Form logic")
struct UIFormLogicTests {
    static func options(_ ids: String...) -> [FormOption] {
        ids.map { FormOption(id: $0, label: "L-\($0)", detail: nil) }
    }

    static let role = FormField(id: "f_role", label: "What do you mostly do?", required: true,
                                kind: .single(options: options("pm", "dev", "student"), allowOther: true))
    static let when = FormField(id: "f_when", label: "When should I check in?", required: false,
                                kind: .multi(options: options("morning", "evening", "urgent"), allowOther: false))
    static let notes = FormField(id: "f_notes", label: "Anything else?", required: false,
                                 kind: .text(placeholder: "Optional", multiline: true))
    static let length = FormField(id: "f_len", label: "Reply length", required: true,
                                  kind: .single(options: options("short", "mid"), allowOther: false))
    static let tags = FormField(id: "f_tags", label: "Tags", required: true,
                                kind: .multi(options: options("a", "b", "c"), allowOther: true))
    static let fields = [role, when, notes]

    @Test func singlePicksOneAndOtherReplacesIt() {
        var draft = FormDraft()
        FormLogic.toggle("pm", in: Self.role, draft: &draft)
        FormLogic.toggle("dev", in: Self.role, draft: &draft)
        #expect(draft.selected["f_role"] == ["dev"])
        // A required single keeps its pick on a second tap.
        FormLogic.toggle("dev", in: Self.role, draft: &draft)
        #expect(draft.selected["f_role"] == ["dev"])
        // Other replaces the option; picking an option again turns Other off.
        FormLogic.toggleOther(in: Self.role, draft: &draft)
        #expect(draft.isOtherOn("f_role"))
        #expect(draft.selected["f_role"]?.isEmpty == true)
        FormLogic.setText("Designer", in: "f_role", draft: &draft)
        #expect(FormLogic.answer(Self.role, draft: draft) == FormAnswer(fieldId: "f_role", optionIds: [], text: "Designer"))
        FormLogic.toggle("pm", in: Self.role, draft: &draft)
        #expect(!draft.isOtherOn("f_role"))
        #expect(FormLogic.answer(Self.role, draft: draft) == FormAnswer(fieldId: "f_role", optionIds: ["pm"], text: nil))
        // The typed text is kept for when Other comes back.
        FormLogic.toggleOther(in: Self.role, draft: &draft)
        #expect(FormLogic.answer(Self.role, draft: draft)?.text == "Designer")
    }

    @Test func optionalSingleClearsOnSecondTap() {
        let optional = FormField(id: "f_o", label: "Pick", required: false, kind: .single(options: Self.options("x", "y"), allowOther: false))
        var draft = FormDraft()
        FormLogic.toggle("x", in: optional, draft: &draft)
        FormLogic.toggle("x", in: optional, draft: &draft)
        #expect(FormLogic.answer(optional, draft: draft) == nil)
    }

    @Test func multiTogglesAndKeepsTheFieldsOrder() {
        var draft = FormDraft()
        FormLogic.toggle("urgent", in: Self.when, draft: &draft)
        FormLogic.toggle("morning", in: Self.when, draft: &draft)
        FormLogic.toggle("evening", in: Self.when, draft: &draft)
        FormLogic.toggle("evening", in: Self.when, draft: &draft)
        #expect(FormLogic.answer(Self.when, draft: draft)?.optionIds == ["morning", "urgent"])
        // Unknown ids and Other on a field without allowOther do nothing.
        FormLogic.toggle("nope", in: Self.when, draft: &draft)
        FormLogic.toggleOther(in: Self.when, draft: &draft)
        #expect(!draft.isOtherOn("f_when"))
        #expect(FormLogic.answer(Self.when, draft: draft)?.optionIds == ["morning", "urgent"])
    }

    @Test func multiWithOtherSendsBoth() {
        var draft = FormDraft()
        FormLogic.toggle("b", in: Self.tags, draft: &draft)
        FormLogic.toggleOther(in: Self.tags, draft: &draft)
        #expect(draft.selected["f_tags"] == ["b"])
        FormLogic.setText("  custom \n", in: "f_tags", draft: &draft)
        #expect(FormLogic.answer(Self.tags, draft: draft) == FormAnswer(fieldId: "f_tags", optionIds: ["b"], text: "custom"))
        #expect(FormLogic.summary([Self.tags], answers: FormLogic.answers([Self.tags], draft: draft)) == "Tags: L-b, custom")
    }

    @Test func blankTextIsNoAnswer() {
        var draft = FormDraft()
        FormLogic.toggleOther(in: Self.role, draft: &draft)
        FormLogic.setText("   \n ", in: "f_role", draft: &draft)
        #expect(!FormLogic.isAnswered(Self.role, draft: draft))
        FormLogic.setText("  ", in: "f_notes", draft: &draft)
        #expect(!FormLogic.isAnswered(Self.notes, draft: draft))
        // Text typed into Other while it is off doesn't count.
        var off = FormDraft()
        FormLogic.setText("Designer", in: "f_role", draft: &off)
        #expect(!FormLogic.isAnswered(Self.role, draft: off))
    }

    @Test func submitNeedsRequiredFieldsAndOneAnswer() {
        var draft = FormDraft()
        #expect(!FormLogic.canSubmit(Self.fields, draft: draft))
        FormLogic.toggle("morning", in: Self.when, draft: &draft)
        #expect(!FormLogic.canSubmit(Self.fields, draft: draft))
        FormLogic.toggle("dev", in: Self.role, draft: &draft)
        #expect(FormLogic.canSubmit(Self.fields, draft: draft))
        // All optional: needs at least one answer.
        let optional = [Self.when, Self.notes]
        #expect(!FormLogic.canSubmit(optional, draft: FormDraft()))
        var one = FormDraft()
        FormLogic.setText("hi", in: "f_notes", draft: &one)
        #expect(FormLogic.canSubmit(optional, draft: one))
    }

    @Test func answersAndSummaryFollowTheFormsOrder() {
        var draft = FormDraft()
        FormLogic.setText("Mornings are\nbusy", in: "f_notes", draft: &draft)
        FormLogic.toggle("evening", in: Self.when, draft: &draft)
        FormLogic.toggle("morning", in: Self.when, draft: &draft)
        FormLogic.toggle("pm", in: Self.role, draft: &draft)
        let answers = FormLogic.answers(Self.fields, draft: draft)
        #expect(answers.map(\.fieldId) == ["f_role", "f_when", "f_notes"])
        #expect(answers[2].text == "Mornings are\nbusy")
        #expect(FormLogic.summary(Self.fields, answers: answers) == """
            What do you mostly do?: L-pm
            When should I check in?: L-morning, L-evening
            Anything else?: Mornings are busy
            """)
        // Unanswered optional fields are left out of both.
        var short = FormDraft()
        FormLogic.toggle("student", in: Self.role, draft: &short)
        let only = FormLogic.answers(Self.fields, draft: short)
        #expect(only.count == 1)
        #expect(FormLogic.summary(Self.fields, answers: only) == "What do you mostly do?: L-student")
    }

    @Test func textIsCappedAtTheServersLimit() {
        var draft = FormDraft()
        FormLogic.setText(String(repeating: "a", count: 5000), in: "f_notes", draft: &draft)
        #expect(FormLogic.answer(Self.notes, draft: draft)?.text?.count == FormLogic.maxText)
    }

    @Test func submitsOnTapOnlyForOneRequiredSingleWithoutOther() {
        #expect(FormLogic.submitsOnTap([Self.length]))
        #expect(!FormLogic.submitsOnTap([Self.role]))
        #expect(!FormLogic.submitsOnTap([Self.length, Self.notes]))
        #expect(!FormLogic.submitsOnTap([Self.when]))
        let optional = FormField(id: "f_o", label: "Pick", required: false, kind: .single(options: Self.options("x", "y"), allowOther: false))
        #expect(!FormLogic.submitsOnTap([optional]))
    }

    @Test func submittedDraftRestoresThePicks() {
        let answers = [
            FormAnswer(fieldId: "f_role", optionIds: [], text: "Designer"),
            FormAnswer(fieldId: "f_when", optionIds: ["urgent", "morning"], text: nil),
            FormAnswer(fieldId: "f_notes", optionIds: [], text: "Hi"),
            FormAnswer(fieldId: "f_gone", optionIds: ["x"], text: nil),
        ]
        let draft = FormLogic.draft(from: answers, fields: Self.fields)
        #expect(draft.isOtherOn("f_role"))
        #expect(!draft.isOtherOn("f_notes"))
        #expect(draft.selected["f_when"] == ["morning", "urgent"])
        #expect(draft.selected["f_gone"] == nil)
        #expect(FormLogic.answers(Self.fields, draft: draft) == [
            FormAnswer(fieldId: "f_role", optionIds: [], text: "Designer"),
            FormAnswer(fieldId: "f_when", optionIds: ["morning", "urgent"], text: nil),
            FormAnswer(fieldId: "f_notes", optionIds: [], text: "Hi"),
        ])
    }

    @Test func decodesTheContractSample() throws {
        let json = """
            {"title":"Reply length","description":null,"icon":"chat","fields":[{"id":"f_len","type":"single","label":"How long?","required":true,"allowOther":false,"options":[{"id":"o_short","label":"Short","detail":null},{"id":"o_mid","label":"Mid","detail":null}]}],"submitLabel":"Save","state":"submitted","answers":[{"fieldId":"f_len","optionIds":["o_short"],"text":null}]}
            """
        let payload = try JSONDecoder().decode(FormPayload.self, from: Data(json.utf8))
        #expect(FormLogic.submitsOnTap(payload.fields))
        #expect(FormLogic.summary(payload.fields, answers: payload.answers ?? []) == "How long?: Short")
    }
}

@Suite("Usage panel math")
struct UIUsagePanelMathTests {
    static func model(_ label: String, _ input: Int, _ output: Int) -> UsageStats.ModelRow {
        UsageStats.ModelRow(model: label.lowercased(), label: label, provider: nil, inputTokens: input, outputTokens: output, runs: 1)
    }

    @Test func shareIsClampedAndSafeAtZero() {
        #expect(UsageMath.share(25, of: 100) == 0.25)
        #expect(UsageMath.share(5, of: 0) == 0)
        #expect(UsageMath.share(150, of: 100) == 1)
        #expect(UsageMath.percentText(0.256, locale: Locale(identifier: "en_US")) == "26%")
    }

    @Test func modelsSortMostFirstThenByLabel() {
        let rows = [Self.model("Haiku", 10, 5), Self.model("Sonnet", 900, 100), Self.model("Beta", 10, 5)]
        #expect(UsageMath.modelsByUse(rows).map(\.label) == ["Sonnet", "Beta", "Haiku"])
    }

    @Test func kindTilesAreAlwaysFourInOrder() {
        let rows = [
            UsageStats.KindRow(kind: .proactive, inputTokens: 3, outputTokens: 1, runs: 2),
            UsageStats.KindRow(kind: .chat, inputTokens: 10, outputTokens: 5, runs: 4),
        ]
        let tiles = UsageMath.kindTiles(rows)
        #expect(tiles.map(\.kind) == [.chat, .task, .build, .proactive])
        #expect(tiles.map(\.total) == [15, 0, 0, 4])
    }

    @Test func emptyRangeReadsAsNoUsage() throws {
        let json = """
            {"range":"today","since":"2026-10-26T00:00:00.000Z","until":"2026-10-26T10:00:00.000Z","totals":{"inputTokens":0,"outputTokens":0,"runs":0},"estimated":false,"byModel":[],"byKind":[],"bucket":"hour","series":[]}
            """
        let stats = try JSONCoding.decoder().decode(UsageStats.self, from: Data(json.utf8))
        #expect(UsageMath.isEmpty(stats))
        #expect(stats.bucket == .hour)
    }
}
