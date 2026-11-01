// Files (App/ComputerContract.swift, PART C, L179, L180): a file's type for its glyph and
// preview, the safe local name of a preview copy, Content-Disposition names, newest-first
// lists, the HTML preview's CSP, and OpenDuet's computer kept out of the apps catalog.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private func fileJSON(_ id: String, name: String = "report.pdf", mime: String = "application/pdf", at t: Int = 0) -> [String: Any] {
    [
        "id": id, "channelId": Fx.main, "messageId": NSNull(), "name": name, "mime": mime, "size": 2048,
        "source": "assistant", "url": "/api/files/\(id)/content", "createdAt": Fx.iso(t),
    ]
}

private func file(_ id: String, name: String = "report.pdf", at t: Int = 0) -> ChannelFile {
    Fx.decode(ChannelFile.self, fileJSON(id, name: name, at: t))
}

@Suite("File kinds and names")
struct UIFileKindTests {
    @Test func kindFromMimeThenExtension() {
        #expect(FileKind(mime: "application/pdf", name: "x") == .pdf)
        #expect(FileKind(mime: "application/octet-stream", name: "Report.PDF") == .pdf)
        #expect(FileKind(mime: "image/png", name: "a.png") == .image)
        #expect(FileKind(mime: "text/html", name: "page") == .html)
        #expect(FileKind(mime: "application/octet-stream", name: "page.htm") == .html)
        #expect(FileKind(mime: "text/csv", name: "a") == .csv)
        #expect(FileKind(mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "a") == .spreadsheet)
        #expect(FileKind(mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", name: "a") == .presentation)
        #expect(FileKind(mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "a") == .document)
        #expect(FileKind(mime: "application/zip", name: "a") == .archive)
        #expect(FileKind(mime: "text/markdown", name: "notes") == .text)
        #expect(FileKind(mime: "application/octet-stream", name: "blob") == .other)
    }

    @Test func onlyHTMLUsesTheWebView() {
        #expect(FileKind.html.usesWebView)
        #expect(!FileKind.pdf.usesWebView)
        #expect(!FileKind.text.usesWebView)
        #expect(FileKind.html.glyph == "globe")
        #expect(FileKind.other.glyph == "doc")
    }

    @Test func localNameIsOneSafeComponentWithAnExtension() {
        #expect(FileNaming.localName("report.pdf", mime: "application/pdf") == "report.pdf")
        #expect(FileNaming.localName("../../etc/passwd", mime: "text/plain") == "etcpasswd.txt")
        #expect(FileNaming.localName("Q3 plan", mime: "application/pdf") == "Q3 plan.pdf")
        #expect(FileNaming.localName("   ", mime: "image/png") == "file.png")
        #expect(FileNaming.localName(".hidden", mime: "application/octet-stream") == "hidden")
        let long = FileNaming.localName(String(repeating: "a", count: 200) + ".csv", mime: "text/csv")
        #expect(long.hasSuffix(".csv"))
        #expect(long.count == 104)
    }

    @Test func extensionIgnoresParameters() {
        #expect(FileNaming.fileExtension(mime: "text/plain; charset=utf-8") == "txt")
        #expect(FileNaming.fileExtension(mime: "IMAGE/JPEG") == "jpg")
        #expect(FileNaming.fileExtension(mime: "application/x-unknown") == nil)
    }

    @Test func dispositionNamePrefersTheEncodedForm() {
        #expect(FileNaming.dispositionName(#"attachment; filename="plan.pdf""#) == "plan.pdf")
        #expect(FileNaming.dispositionName(#"inline; filename="x.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"#) == "résumé.pdf")
        #expect(FileNaming.dispositionName("inline") == nil)
        #expect(FileNaming.dispositionName(nil) == nil)
    }
}

@Suite("File lists")
struct UIFileListTests {
    @Test func sortedNewestFirstTiesKeepOrder() {
        let files = [file("a", at: 10), file("b", at: 30), file("c", at: 10), file("d", at: 20)]
        #expect(FileLists.sorted(files).map(\.id) == ["b", "d", "a", "c"])
    }

    @Test func upsertAddsInPlaceOrReplaces() {
        let list = [file("b", at: 30), file("a", at: 10)]
        #expect(FileLists.upsert(file("c", at: 20), into: list).map(\.id) == ["b", "c", "a"])
        let renamed = FileLists.upsert(file("a", name: "new.pdf", at: 10), into: list)
        #expect(renamed.map(\.id) == ["b", "a"])
        #expect(renamed.last?.name == "new.pdf")
    }

    @Test func filesInAMessage() {
        var json = Fx.messageJSON("m1", at: 0)
        json["kind"] = "file"
        json["payload"] = ["file": fileJSON("f1"), "caption": ""]
        #expect(FileLists.files(in: Fx.decode(Message.self, json)).map(\.id) == ["f1"])
        var text = Fx.messageJSON("m2", at: 0)
        text["payload"] = ["skill": NSNull(), "attachments": [fileJSON("f2"), fileJSON("f3")]]
        #expect(FileLists.files(in: Fx.decode(Message.self, text)).map(\.id) == ["f2", "f3"])
        #expect(FileLists.files(in: Fx.message("m3", at: 0)).isEmpty)
    }
}

@Suite("HTML preview and the apps catalog")
struct UIFilePreviewSafetyTests {
    private let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(HTMLPreview.policy)\">"

    @Test func cspGoesRightAfterHead() {
        #expect(HTMLPreview.harden("<html><head><title>x</title></head></html>") == "<html><head>\(meta)<title>x</title></head></html>")
        #expect(HTMLPreview.harden("<HEAD lang=\"en\"><body>") == "<HEAD lang=\"en\">\(meta)<body>")
    }

    @Test func headerIsNotHead() {
        #expect(HTMLPreview.harden("<header>Hi</header>") == "\(meta)<header>Hi</header>")
        #expect(HTMLPreview.harden("<p>no head</p>") == "\(meta)<p>no head</p>")
    }

    @Test func policyBlocksTheNetworkAndScripts() {
        #expect(HTMLPreview.policy.hasPrefix("default-src 'none'"))
        #expect(!HTMLPreview.policy.contains("script-src"))
        #expect(!HTMLPreview.policy.contains("http"))
    }

    @Test func computerIsNotAnApp() {
        let list = Fx.connectors([
            Fx.connectorJSON(ComputerToolkit.slug, category: nil),
            Fx.connectorJSON("gmail", category: "mail", connected: true),
            Fx.connectorJSON("notion", category: nil),
        ])
        #expect(AccessLayout.catalog(list.connectors).map(\.toolkit) == ["gmail", "notion"])
    }

    @Test func emptyDetailLoadsWithNoTools() {
        var board = AccountBoard()
        board.openDetail(ComputerToolkit.slug)
        #expect(board.connectorDetail?.phase == .loading)
        board.emptyDetail("gmail")
        #expect(board.connectorDetail?.phase == .loading)
        board.emptyDetail(ComputerToolkit.slug)
        #expect(board.connectorDetail?.phase == .loaded)
        #expect(board.connectorDetail?.tools.isEmpty == true)
    }
}
