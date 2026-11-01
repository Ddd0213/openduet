// M29 fixes: a deep link's scroll waits for the thread to be on screen and laid out and is done
// only once the row is measured in view (FocusScrollRule); Paste in the composer takes images
// as attachments, the text as before (PasteRules).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M29 deep link focus scroll")
struct UIM29FocusScrollTests {
    private func next(active: Bool = true, laidOut: Bool = true, holding: Bool = false, scrolling: Bool = false,
                      attempts: Int = 0, waits: Int = 0, shown: Bool = false) -> FocusScrollRule.Step {
        FocusScrollRule.next(active: active, laidOut: laidOut, holdingBottom: holding, userScrolling: scrolling,
                             attempts: attempts, waits: waits, shown: shown)
    }

    @Test("Off screen (another tab, a task over it) nothing scrolls and the focus isn't done")
    func waitsOffScreen() {
        #expect(next(active: false) == .wait)
        #expect(next(active: false, attempts: 2, shown: true) == .wait)
        #expect(!FocusScrollRule.mayScroll(active: false, laidOut: true, holdingBottom: false, userScrolling: false))
    }

    @Test("On screen: it scrolls once both edges are measured and no older page is going in")
    func scrollsWhenReady() {
        #expect(next() == .scroll)
        #expect(next(laidOut: false) == .wait)
        #expect(next(holding: true) == .wait)
        #expect(next(laidOut: false, waits: FocusScrollRule.maxWaits) == .scroll, "it doesn't wait forever")
    }

    @Test("Done only after a scroll that left the row in view; else it scrolls again, then lets go")
    func doneOrRetry() {
        #expect(next(shown: true) == .scroll, "in view before any scroll isn't proof the link landed")
        #expect(next(attempts: 1, shown: true) == .done)
        #expect(next(attempts: 1, shown: false) == .scroll)
        #expect(next(attempts: FocusScrollRule.maxAttempts, shown: false) == .letGo)
        #expect(next(attempts: FocusScrollRule.maxAttempts, shown: true) == .done)
    }

    @Test("The user's own scroll takes over")
    func userTakesOver() {
        #expect(next(scrolling: true) == .letGo)
        #expect(next(scrolling: true, attempts: 1, shown: true) == .letGo)
    }

    @Test("In view: half the row, or half the visible area for a row taller than it")
    func shown() {
        // Visible area 100...700.
        #expect(FocusScrollRule.isShown(rowTop: 300, rowBottom: 500, visibleTop: 100, visibleBottom: 700))
        #expect(FocusScrollRule.isShown(rowTop: 600, rowBottom: 800, visibleTop: 100, visibleBottom: 700), "half of it")
        #expect(!FocusScrollRule.isShown(rowTop: 650, rowBottom: 850, visibleTop: 100, visibleBottom: 700))
        #expect(!FocusScrollRule.isShown(rowTop: 1900, rowBottom: 2100, visibleTop: 100, visibleBottom: 700), "still at the bottom")
        #expect(FocusScrollRule.isShown(rowTop: -200, rowBottom: 1200, visibleTop: 100, visibleBottom: 700), "a tall card filling the screen")
        #expect(!FocusScrollRule.isShown(rowTop: .nan, rowBottom: 500, visibleTop: 100, visibleBottom: 700))
        #expect(!FocusScrollRule.isShown(rowTop: 300, rowBottom: 300, visibleTop: 100, visibleBottom: 700))
    }
}

@Suite("M29 paste images into the composer")
struct UIM29PasteTests {
    @Test("Paste is offered for images only where the composer takes attachments")
    func offers() {
        #expect(PasteRules.offersPaste(systemOffers: false, acceptsImages: true, hasImages: true))
        #expect(!PasteRules.offersPaste(systemOffers: false, acceptsImages: false, hasImages: true))
        #expect(!PasteRules.offersPaste(systemOffers: false, acceptsImages: true, hasImages: false))
        #expect(PasteRules.offersPaste(systemOffers: true, acceptsImages: false, hasImages: false), "text as before")
    }

    @Test("Images become attachments; the text of the same paste still goes into the field")
    func plan() {
        #expect(PasteRules.plan(acceptsImages: true, hasImages: true, hasStrings: false) == .init(pastesText: false, attachesImages: true))
        #expect(PasteRules.plan(acceptsImages: true, hasImages: true, hasStrings: true) == .init(pastesText: true, attachesImages: true))
        #expect(PasteRules.plan(acceptsImages: true, hasImages: false, hasStrings: true) == .init(pastesText: true, attachesImages: false))
        #expect(PasteRules.plan(acceptsImages: false, hasImages: true, hasStrings: false) == .init(pastesText: true, attachesImages: false),
                "no attachments here: the system's paste as before")
        #expect(PasteRules.maxImages == 10)
    }

    @Test("A named PNG / JPEG / HEIC item is a file; anything else is a picture (the camera's JPEG)")
    func source() {
        #expect(PasteRules.source(types: ["public.png", "public.jpeg"], suggestedName: "Plan") == .file(type: "public.png"))
        #expect(PasteRules.source(types: ["public.heic"], suggestedName: "IMG_0042.HEIC") == .file(type: "public.heic"))
        #expect(PasteRules.source(types: ["public.png"], suggestedName: nil) == .picture)
        #expect(PasteRules.source(types: ["public.png"], suggestedName: "  ") == .picture)
        #expect(PasteRules.source(types: ["public.tiff"], suggestedName: "Scan") == .picture)
    }

    @Test("A pasted file's name keeps its extension or gets its type's; the MIME type follows the type")
    func names() {
        #expect(PasteRules.fileName("Plan", type: "public.png") == "Plan.png")
        #expect(PasteRules.fileName("Plan.PNG", type: "public.png") == "Plan.PNG")
        #expect(PasteRules.fileName("photo.jpeg", type: "public.jpeg") == "photo.jpeg")
        #expect(PasteRules.fileName("photo", type: "public.jpeg") == "photo.jpg")
        #expect(PasteRules.fileName("IMG_1.heic", type: "public.heic") == "IMG_1.heic")
        #expect(PasteRules.fileName(nil, type: "public.png") == "Image.png")
        #expect(PasteRules.mime(type: "public.png") == "image/png")
        #expect(PasteRules.mime(type: "public.jpeg") == "image/jpeg")
        #expect(PasteRules.mime(type: "public.heic") == "image/heic", "turned into JPEG by AttachmentLoader, as Files")
    }
}
