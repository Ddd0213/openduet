// M19: the page hierarchy inside sheets (Components/PushStackRules.swift): push / pop / replace
// from the old page, the new one and the parent chain (the settings' tree as the sample), the edge
// swipes' release rule, and when the settings fetch a part again (Account/FetchFreshness.swift).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Push stack (M19)")
struct UIM19NavTests {
    /// The settings' shape: Apps > Add connector > Add manually; Apps > connector; Models >
    /// Add provider > provider form; Usage at the top.
    enum Page: Hashable {
        case usage, apps, addConnector, addManually, connector(String)
        case models, addProvider, providerForm
    }

    static func parent(_ page: Page) -> Page? {
        switch page {
        case .usage, .apps, .models: nil
        case .addConnector, .connector: .apps
        case .addManually: .addConnector
        case .addProvider: .models
        case .providerForm: .addProvider
        }
    }

    private func move(_ old: Page?, _ new: Page?) -> PushStackMove {
        PushStackRules.move(from: old, to: new, parent: Self.parent)
    }

    @Test("a child of the page on screen (or of the root, from the root) is a push")
    func pushes() {
        #expect(move(nil, .usage) == .push)
        #expect(move(nil, .apps) == .push)
        #expect(move(.apps, .addConnector) == .push)
        #expect(move(.addConnector, .addManually) == .push)
        #expect(move(.models, .addProvider) == .push)
    }

    @Test("an ancestor or the root is a pop, however many levels up")
    func pops() {
        #expect(move(.addConnector, .apps) == .pop)
        #expect(move(.addManually, .addConnector) == .pop)
        #expect(move(.addManually, .apps) == .pop)
        #expect(move(.addManually, nil) == .pop)
        #expect(move(.usage, nil) == .pop)
        #expect(move(.providerForm, .models) == .pop)
    }

    @Test("a sibling, a cousin or a page more than one level down is a replace")
    func replaces() {
        // Add connector's success opens the new connector (a sibling, under Apps).
        #expect(move(.addConnector, .connector("c1")) == .replace)
        #expect(move(.connector("c1"), .connector("c2")) == .replace)
        #expect(move(.usage, .apps) == .replace)
        #expect(move(.addManually, .providerForm) == .replace)
        // The root straight to a page two levels down (Voice's "Set up models" style).
        #expect(move(nil, .addManually) == .replace)
        #expect(move(.apps, .addManually) == .replace)
    }

    @Test("the same page is no move")
    func same() {
        #expect(move(nil, nil) == .none)
        #expect(move(.apps, .apps) == .none)
    }

    @Test("the chain as it was shown decides: Back after the parent changed still pops")
    func shownChain() {
        // A page came up under Add connector; its parent is Apps now (like a model's page after
        // its delete), but Back to Add connector is still a pop (the container keeps the chain
        // it was shown with). From the live parents it would be a replace.
        let shown = PushStackRules.move(
            from: Page.connector("c1"), to: Page.addConnector,
            oldAncestors: [.addConnector, .apps], newParent: .apps
        )
        #expect(shown == .pop)
        #expect(move(.connector("c1"), .addConnector) == .replace)
    }

    @Test("ancestors are nearest first, without the root, and stop on a loop")
    func ancestors() {
        #expect(PushStackRules.ancestors(of: Page.addManually, parent: Self.parent) == [.addConnector, .apps])
        #expect(PushStackRules.ancestors(of: Page.apps, parent: Self.parent) == [])
        let loop: (Int) -> Int? = { $0 == 1 ? 2 : 1 }
        #expect(PushStackRules.ancestors(of: 1, parent: loop) == [2])
        let selfLoop: (Int) -> Int? = { $0 }
        #expect(PushStackRules.ancestors(of: 5, parent: selfLoop) == [])
    }

    @Test("an edge swipe commits past a third of its length or on a flick that reaches half")
    func swipeRelease() {
        #expect(!PushStackRules.swipeCommits(translation: 100, projected: 150, length: 390))
        #expect(PushStackRules.swipeCommits(translation: 131, projected: 131, length: 390))
        #expect(PushStackRules.swipeCommits(translation: 40, projected: 200, length: 390))
        #expect(!PushStackRules.swipeCommits(translation: 0, projected: 0, length: 312))
        #expect(!PushStackRules.swipeCommits(translation: 10, projected: 10, length: 0))
        // A UIKit pan's projected end: 0.15 s of its release velocity on top.
        #expect(abs(PushStackRules.projected(translation: 60, velocity: 1000) - 210) < 0.001)
        #expect(abs(PushStackRules.projected(translation: 60, velocity: -400)) < 0.001)
    }

    @Test("a part fetched less than a minute ago is skipped while it is loaded")
    func freshness() {
        var fresh = FetchFreshness()
        let t0 = Date(timeIntervalSinceReferenceDate: 1000)
        func claim(_ key: String, _ loaded: Bool, _ dt: TimeInterval) -> Bool {
            fresh.claim(key, loaded: loaded, now: t0.addingTimeInterval(dt))
        }
        let first = claim("profile", false, 0)
        let within = claim("profile", true, 30)
        let after = claim("profile", true, 60)
        #expect(first && !within && after)
        // Missing or failed: always fetched, and the fetch is noted.
        let voiceFirst = claim("voice", true, 0)
        let voiceFailed = claim("voice", false, 5)
        let voiceAgain = claim("voice", true, 10)
        #expect(voiceFirst && voiceFailed && !voiceAgain)
        // A clock that went back counts as stale.
        let backwards = claim("voice", true, -100)
        #expect(backwards)
        fresh.reset("voice")
        let afterReset = claim("voice", true, 0)
        #expect(afterReset)
    }
}
