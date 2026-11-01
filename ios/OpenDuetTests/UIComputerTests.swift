// OpenDuet's computer (App/ComputerContract.swift, PART C §1, L143, L141): the screen's geometry
// and input, what the full-screen view shows, Take over / Hand back state, the sign-in card's
// look, the site letter badge, the stream socket's address and the live screen's viewer count.
import CoreGraphics
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private func computer(
    available: Bool = true, browser: ComputerState.Browser = .ready,
    controller: ComputerState.Controller = .assistant, domain: String? = "example.com"
) -> ComputerState {
    ComputerState(available: available, browser: browser, controller: controller, url: nil, domain: domain, blocked: nil)
}

private func view(_ state: ComputerState?, control: ComputerViewState.Control = .idle) -> ComputerViewState {
    var view = ComputerViewState()
    if let state { view.apply(state) }
    view.control = control
    return view
}

@Suite("Computer geometry and input")
struct UIComputerGeometryTests {
    @Test func fittedFillsWidthUnlessTooTall() {
        let page = CGSize(width: 1600, height: 1000)
        #expect(ComputerGeometry.fitted(frame: page, in: CGSize(width: 400, height: 800)) == CGSize(width: 400, height: 250))
        // Landscape: the height limits it.
        #expect(ComputerGeometry.fitted(frame: page, in: CGSize(width: 800, height: 250)) == CGSize(width: 400, height: 250))
        #expect(ComputerGeometry.fitted(frame: page, in: CGSize(width: 900, height: 125)) == CGSize(width: 200, height: 125))
        #expect(ComputerGeometry.fitted(frame: .zero, in: CGSize(width: 400, height: 800)) == .zero)
        #expect(ComputerGeometry.fitted(frame: page, in: .zero) == .zero)
    }

    @Test func fractionClampsToTheFrame() {
        let shown = CGSize(width: 400, height: 250)
        #expect(ComputerGeometry.fraction(of: CGPoint(x: 100, y: 125), in: shown) == ComputerClientMessage.Point(x: 0.25, y: 0.5))
        #expect(ComputerGeometry.fraction(of: CGPoint(x: -20, y: 400), in: shown) == ComputerClientMessage.Point(x: 0, y: 1))
        #expect(ComputerGeometry.fraction(of: .zero, in: .zero) == nil)
    }

    @Test func scrollIsInPagePixelsAndInverted() {
        let delta = ComputerGeometry.scroll(
            translation: CGSize(width: 10, height: -50),
            shown: CGSize(width: 400, height: 250), page: CGSize(width: 1600, height: 1000)
        )
        #expect(delta.dx == -40)
        #expect(delta.dy == 200)
        let none = ComputerGeometry.scroll(translation: CGSize(width: 5, height: 5), shown: .zero, page: CGSize(width: 1600, height: 1000))
        #expect(none.dx == 0 && none.dy == 0)
    }

    @Test func typingSendsTextAndBackspaces() {
        #expect(ComputerTyping.messages(from: "", to: "hi") == [.text("hi")])
        #expect(ComputerTyping.messages(from: "hi", to: "hi") == [])
        #expect(ComputerTyping.messages(from: "hello", to: "he") == [.key(.backspace), .key(.backspace), .key(.backspace)])
        // Autocorrect replacing a word: back over the changed part, then type the new one.
        #expect(ComputerTyping.messages(from: "teh", to: "the") == [.key(.backspace), .key(.backspace), .text("he")])
        // An emoji is one character, so one backspace.
        #expect(ComputerTyping.messages(from: "a👍", to: "a") == [.key(.backspace)])
    }
}

@Suite("Computer presentation")
struct UIComputerPresentationTests {
    @Test func pillPrefersControlThenWakingThenStatus() {
        #expect(ComputerPresentation.pill(computer: computer(controller: .user), status: .thinking) == .inControl)
        #expect(ComputerPresentation.pill(computer: computer(browser: .starting), status: .thinking) == .waking)
        #expect(ComputerPresentation.pill(computer: computer(browser: .off), status: nil) == .waking)
        #expect(ComputerPresentation.pill(computer: computer(), status: .thinking) == .status(.thinking))
        #expect(ComputerPresentation.pill(computer: computer(), status: nil) == .idle)
        #expect(ComputerPresentation.pill(computer: nil, status: nil) == .idle)
        #expect(ComputerPresentation.pill(computer: computer(available: false, browser: .off), status: nil) == .idle)
    }

    @Test func bodyFollowsLoadAvailabilityAndBrowser() {
        #expect(ComputerPresentation.body(ComputerViewState()) == .loading)
        var failed = ComputerViewState()
        failed.phase = .failed(reason: "Can't reach your server")
        #expect(ComputerPresentation.body(failed) == .failed(reason: "Can't reach your server"))
        #expect(ComputerPresentation.body(view(computer(available: false, browser: .off))) == .unavailable)
        #expect(ComputerPresentation.body(view(computer(browser: .starting))) == .waking)
        #expect(ComputerPresentation.body(view(computer())) == .screen)
    }

    @Test func takeOverNeedsTheScreenHandBackDoesNot() {
        #expect(ComputerPresentation.canToggleControl(view(computer())))
        #expect(!ComputerPresentation.canToggleControl(view(computer(browser: .starting))))
        #expect(ComputerPresentation.canToggleControl(view(computer(browser: .starting, controller: .user))))
        #expect(!ComputerPresentation.canToggleControl(view(computer(), control: .taking)))
        #expect(!ComputerPresentation.canToggleControl(view(computer(controller: .user), control: .releasing)))
        #expect(ComputerPresentation.canToggleControl(view(computer(), control: .failed(reason: "x"))))
    }

    @Test func applyEndsAWaitingTakeOrRelease() {
        var state = view(nil, control: .taking)
        state.apply(computer(controller: .assistant))
        #expect(state.control == .taking)
        #expect(state.phase == .loaded)
        state.apply(computer(controller: .user))
        #expect(state.control == .idle)
        #expect(state.isUserInControl)
        state.control = .releasing
        state.apply(computer(controller: .assistant))
        #expect(state.control == .idle)
        state.control = .failed(reason: "x")
        state.apply(computer(controller: .user))
        #expect(state.control == .failed(reason: "x"))
    }
}

@Suite("Sign-in card and site badge")
struct UIComputerSignInTests {
    @Test func phaseResolvesInOrder() {
        #expect(SignInCardPhase.resolve(payload: .pending, answer: nil, request: nil) == .form)
        #expect(SignInCardPhase.resolve(payload: .pending, answer: nil, request: .inFlight) == .sending)
        #expect(SignInCardPhase.resolve(payload: .pending, answer: .sent, request: nil) == .sent)
        #expect(SignInCardPhase.resolve(payload: .sent, answer: nil, request: nil) == .sent)
        #expect(SignInCardPhase.resolve(payload: .pending, answer: .expired, request: nil) == .expired)
        #expect(SignInCardPhase.resolve(payload: .expired, answer: .sent, request: nil) == .expired)
        #expect(SignInCardPhase.resolve(payload: .pending, answer: nil, request: .failed(reason: "Offline")) == .failed(reason: "Offline"))
        #expect(SignInCardPhase.resolve(payload: .pending, answer: .failed, request: nil) == .failed(reason: nil))
        #expect(SignInCardPhase.resolve(payload: .failed, answer: nil, request: nil) == .failed(reason: nil))
    }

    @Test func monogramIsTheSiteNamesFirstLetter() {
        #expect(SiteMonogram.letter(for: "accounts.google.com") == "G")
        #expect(SiteMonogram.letter(for: "www.github.com") == "G")
        #expect(SiteMonogram.letter(for: "news.bbc.co.uk") == "B")
        #expect(SiteMonogram.letter(for: "Example.org/login") == "E")
        #expect(SiteMonogram.letter(for: "localhost") == "L")
        #expect(SiteMonogram.letter(for: "") == "?")
    }

    @Test func requestKeysAndSlug() {
        #expect(ShellState.RequestKey.signIn("req_1") == "signin:req_1")
        #expect(ComputerToolkit.slug == "duet_computer")
    }
}

@Suite("Computer stream")
struct UIComputerStreamTests {
    @Test func socketURLKeepsHostPortAndPath() {
        #expect(ComputerSocket.url(from: URL(string: "https://duet.example.com/api/computer/stream")!)?.absoluteString == "wss://duet.example.com/api/computer/stream")
        #expect(ComputerSocket.url(from: URL(string: "http://192.168.1.4:8787/api/computer/stream")!)?.absoluteString == "ws://192.168.1.4:8787/api/computer/stream")
        #expect(ComputerSocket.url(from: URL(string: "ftp://example.com/x")!) == nil)
    }

    @MainActor @Test func demandFollowsTheFirstAndLastViewer() {
        let screen = LiveScreen()
        var calls: [Bool] = []
        screen.onDemand = { calls.append($0) }
        screen.attach()
        screen.attach()
        #expect(calls == [true])
        #expect(screen.hasViewers)
        screen.detach()
        #expect(calls == [true])
        screen.detach()
        #expect(calls == [true, false])
        screen.detach()
        #expect(calls == [true, false])
        #expect(!screen.hasViewers)
    }

    @MainActor @Test func framesCountAndResetForgets() {
        let screen = LiveScreen()
        screen.setConnection(.connecting)
        screen.show(Data([0xFF, 0xD8]))
        screen.show(Data([0xFF, 0xD9]))
        #expect(screen.frameNumber == 2)
        #expect(screen.connection == .live)
        screen.setSize(width: 1280, height: 800)
        #expect(screen.pixelWidth == 1280 && screen.pixelHeight == 800)
        screen.reset()
        #expect(screen.frame == nil)
        #expect(screen.connection == .idle)
        #expect(screen.pixelWidth == 0)
    }
}
