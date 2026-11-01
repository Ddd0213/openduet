// M25 W2 UI logic: the skills page's Add skill menu, which files Upload a skill takes and the
// upload's inline failure lines (400 / 413), Create with OpenDuet's prefill and the shell's compose
// request, the Uploaded label and its scripts note, and the connectors page's Built in rows
// (name, icon, what each sends where, Open-Meteo's credit, the status line by state).
import Foundation
import Testing
import UniformTypeIdentifiers
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M25 skills page")
struct UIM25SkillsTests {
    @Test("Add skill: Create with OpenDuet, Upload a skill, Import from GitHub, in that order")
    func menu() {
        #expect(SkillAddEntry.allCases == [.createWithAssistant, .upload, .github])
        #expect(SkillAddEntry.allCases.map(\.title.key) == ["Create with OpenDuet", "Upload a skill", "Import from GitHub"])
        #expect(Set(SkillAddEntry.allCases.map(\.symbol)).count == 3)
    }

    @Test("Upload takes .zip / .skill (20 MB) and .md / .txt (1 MB) by extension, any case; nothing else")
    func uploadKinds() {
        #expect(SkillUpload.kind(forFileName: "pack.zip") == .archive)
        #expect(SkillUpload.kind(forFileName: "meeting-minutes.skill") == .archive)
        #expect(SkillUpload.kind(forFileName: "PACK.ZIP") == .archive)
        #expect(SkillUpload.kind(forFileName: "SKILL.md") == .markdown)
        #expect(SkillUpload.kind(forFileName: "notes.Markdown") == .markdown)
        #expect(SkillUpload.kind(forFileName: "skill.txt") == .markdown)
        #expect(SkillUpload.kind(forFileName: "photo.png") == nil)
        #expect(SkillUpload.kind(forFileName: "SKILL") == nil)
        #expect(SkillUpload.kind(forFileName: "archive.skill.pdf") == nil)
        #expect(SkillUpload.limit(.archive) == 20 * 1024 * 1024)
        #expect(SkillUpload.limit(.markdown) == 1024 * 1024)
        #expect(SkillUpload.mime(.archive) == "application/zip")
        #expect(SkillUpload.mime(.markdown) == "text/markdown")
    }

    @Test("The Files picker shows zips first and keeps .data last, so an undeclared .skill can be picked")
    func pickerTypes() {
        let types = SkillUpload.contentTypes
        #expect(types.first == .zip)
        #expect(types.last == .data)
        #expect(types.contains(.plainText))
        #expect(Set(types).count == types.count, "no type twice")
    }

    @Test("Upload failures: 413 by kind; the server's 400 texts in the app's words; others as sent")
    func failureLines() {
        #expect(SkillUpload.failureLine(for: APIError.tooLarge, kind: .archive) == "Skills can be up to 20 MB.")
        #expect(SkillUpload.failureLine(for: APIError.tooLarge, kind: .markdown) == "A SKILL.md can be up to 1 MB.")
        func bad(_ message: String) -> String? {
            SkillUpload.failureLine(for: APIError.validationFailed(field: "file", message: message), kind: .markdown)
        }
        #expect(bad("file: Upload a .zip, a .skill or a SKILL.md file.") == "Upload a .zip, a .skill or a SKILL.md file.")
        #expect(bad("file: SKILL.md needs a name in its frontmatter.") == "SKILL.md needs a name in its frontmatter.")
        #expect(bad("file: SKILL.md has no instructions.") == "SKILL.md has no instructions.")
        #expect(bad("file: The file is empty.") == "The file is empty.")
        #expect(bad("file: a.zip: too many entries") == "a.zip: too many entries", "an unknown reason shows as sent")
        #expect(bad("") == "Check your answers and try again.")
        #expect(SkillUpload.failureLine(for: CancellationError(), kind: nil) == nil)
        #expect(SkillUpload.failureLine(for: APIError.unreachable, kind: .archive) == "Can't reach your server.")
    }

    @Test("Create with OpenDuet: the prefill alone, after what was typed, or not twice")
    func prefill() {
        #expect(SkillCreatePrefill.text.key == "Help me create a skill: ")
        let prefill = "Help me create a skill: "
        #expect(SkillCreatePrefill.draft(prefill: prefill, current: "") == prefill)
        #expect(SkillCreatePrefill.draft(prefill: prefill, current: "  \n") == prefill)
        #expect(SkillCreatePrefill.draft(prefill: prefill, current: "Draft for Ana  ") == "Draft for Ana\n" + prefill)
        #expect(SkillCreatePrefill.draft(prefill: prefill, current: prefill) == prefill)
        #expect(SkillCreatePrefill.draft(prefill: "帮我创建一个技能：", current: "") == "帮我创建一个技能：")
    }

    @Test("The shell's compose request: each ask bumps the token; the text is taken once")
    @MainActor func composeRequest() {
        let request = ComposeRequest()
        #expect(request.take() == nil)
        request.ask("Help me create a skill: ")
        request.ask("Help me create a skill: ")
        #expect(request.token == 2)
        #expect(request.take() == "Help me create a skill: ")
        #expect(request.take() == nil)
    }

    @Test("An uploaded skill reads Uploaded; its scripts ask first like GitHub and zip ones")
    func uploadedLabel() {
        #expect(SkillSource.upload.label.key == "Uploaded")
        #expect(SkillSource.upload.scriptsAskFirst && SkillSource.github.scriptsAskFirst && SkillSource.zip.scriptsAskFirst)
        #expect(!SkillSource.manual.scriptsAskFirst)
    }
}

@Suite("M25 built-in connectors rows")
struct UIM25BuiltinRowsTests {
    private func row(_ kind: BuiltinConnector.Kind, _ state: BuiltinConnector.State? = .on, _ providers: [String] = []) -> BuiltinConnector {
        BuiltinConnector(kind: kind, state: state, providers: providers, keyless: true, checkedAt: nil)
    }

    private func text(_ resource: LocalizedStringResource?) -> String? {
        resource.map { String(localized: $0) }
    }

    @Test("Each id has its own name and icon")
    func names() {
        #expect(BuiltinConnector.Kind.allCases.map { BuiltinConnectorCopy.title($0).key } == ["Web search", "Weather", "Exchange rates", "News feeds"])
        #expect(Set(BuiltinConnector.Kind.allCases.map(BuiltinConnectorCopy.symbol)).count == 4)
    }

    @Test("What each sends where: the providers as sent, in the order tried")
    func sends() {
        let keyless = BuiltinConnectorCopy.sends(row(.webSearch, .on, ["Exa", "Parallel"]))
        #expect(keyless?.key == "Your search words go to %@ (%@ when it's busy).")
        #expect(text(keyless) == "Your search words go to Exa (Parallel when it's busy).")
        #expect(text(BuiltinConnectorCopy.sends(row(.webSearch, .on, ["Tavily"]))) == "Your search words go to Tavily.")
        #expect(BuiltinConnectorCopy.sends(row(.webSearch, .off, [])) == nil, "off with no provider: only the status line")
        #expect(text(BuiltinConnectorCopy.sends(row(.weather, .on, ["Open-Meteo"]))) == "The place name goes to Open-Meteo.")
        #expect(text(BuiltinConnectorCopy.sends(row(.weather, .off, []))) == "The place name goes to Open-Meteo.")
        #expect(text(BuiltinConnectorCopy.sends(row(.exchangeRate, .on, ["Frankfurter"]))) == "The currency codes go to Frankfurter (European Central Bank rates).")
        #expect(BuiltinConnectorCopy.sends(row(.readFeed))?.key == "OpenDuet reads the feed from its own site.")
        #expect(BuiltinConnectorCopy.list(["Parallel", "Brave"], locale: Locale(identifier: "en_US")) == "Parallel and Brave")
    }

    @Test("Weather credits Open-Meteo; off and unreachable have a status line, on and unknown none")
    func status() {
        #expect(BuiltinConnectorCopy.credit(.weather)?.key == "Weather data by Open-Meteo.com")
        #expect(BuiltinConnectorCopy.credit(.webSearch) == nil && BuiltinConnectorCopy.credit(.readFeed) == nil)
        #expect(BuiltinConnectorCopy.status(.off)?.key == "Turned off on this server")
        #expect(BuiltinConnectorCopy.status(.unreachable)?.key == "Can't be reached right now")
        #expect(BuiltinConnectorCopy.status(.on) == nil)
        #expect(BuiltinConnectorCopy.status(nil) == nil, "a state from a newer server reads like on")
    }

    @Test("The sample lists decode into rows in the server's order")
    func samples() throws {
        let json = #"{"connectors":[{"id":"web_search","state":"on","providers":["Exa","Parallel"],"keyless":true,"checkedAt":null},{"id":"weather","state":"unreachable","providers":["Open-Meteo"],"keyless":true,"checkedAt":"2027-01-19T08:05:00.000Z"},{"id":"exchange_rate","state":"on","providers":["Frankfurter"],"keyless":true,"checkedAt":null},{"id":"read_feed","state":"off","providers":[],"keyless":true,"checkedAt":null}]}"#
        let list = try JSONCoding.decoder().decode(BuiltinConnectorList.self, from: Data(json.utf8))
        #expect(list.connectors.map(\.kind) == [.webSearch, .weather, .exchangeRate, .readFeed])
        #expect(list.connectors.map { BuiltinConnectorCopy.status($0.state)?.key } == [nil, "Can't be reached right now", nil, "Turned off on this server"])
    }
}
