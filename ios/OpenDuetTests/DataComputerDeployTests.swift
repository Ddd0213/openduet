// M20 (prompt L138, plan §3 W5): OpenDuet's computer as an optional deploy (Computer/
// ComputerDeployRules.swift): deployed or not, the deploy hint's command, the preview card's
// state line, "Let it sleep" in the full-screen toolbar and the asleep full-screen view.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private func machine(
    available: Bool = true, browser: ComputerState.Browser = .ready,
    controller: ComputerState.Controller = .assistant
) -> ComputerState {
    ComputerState(available: available, browser: browser, controller: controller, url: nil, domain: "example.com", blocked: nil)
}

private func scene(
    mode: ComputerMode = .headless, idle: Int? = 30, _ computer: ComputerState? = nil,
    control: ComputerViewState.Control = .idle
) -> ComputerViewState {
    var view = ComputerViewState()
    view.mode = mode
    view.idleMinutes = idle
    if let computer { view.apply(computer) }
    view.control = control
    return view
}

@Suite("Computer deploy: deployed or not")
struct DataComputerDeployedTests {
    @Test("mode off and available false both read as not deployed")
    func notDeployedEitherWay() {
        #expect(ComputerDeployRules.isDeployed(scene(mode: .off)) == false)
        #expect(ComputerDeployRules.isDeployed(scene(mode: .off, machine())) == false)
        #expect(ComputerDeployRules.isDeployed(scene(mode: .headless, machine(available: false))) == false)
        #expect(ComputerDeployRules.isDeployed(scene(mode: .headed, machine(available: false))) == false)
    }

    @Test("a deployed mode counts as deployed before GET /api/computer answers")
    func deployedBeforeLoad() {
        #expect(ComputerDeployRules.isDeployed(scene(mode: .headless)))
        #expect(ComputerDeployRules.isDeployed(scene(mode: .headed, machine(browser: .off))))
    }

    @Test("the hint's command, and the headed option stays off for now")
    func command() {
        #expect(ComputerDeployRules.deployCommand == "./scripts/setup.sh --computer on")
        #expect(ComputerDeployRules.headedFlag == "--browser headed")
        #expect(ComputerDeployRules.offersHeaded == false)
    }
}

@Suite("Computer deploy: the preview card")
struct DataComputerPreviewTests {
    @Test("asleep carries the idle minutes; none when it never sleeps on its own")
    func asleep() {
        #expect(ComputerDeployRules.previewTag(scene(idle: 30, machine(browser: .off))) == .asleep(idleMinutes: 30))
        #expect(ComputerDeployRules.previewTag(scene(idle: nil, machine(browser: .off))) == .asleep(idleMinutes: nil))
        #expect(ComputerDeployRules.previewTag(scene(idle: 0, machine(browser: .off))) == .asleep(idleMinutes: nil))
    }

    @Test("live, waking, and nothing when not deployed or not loaded")
    func otherTags() {
        #expect(ComputerDeployRules.previewTag(scene(machine(browser: .ready))) == .live)
        #expect(ComputerDeployRules.previewTag(scene(machine(browser: .starting))) == .waking)
        #expect(ComputerDeployRules.previewTag(scene(mode: .off, machine(browser: .off))) == .none)
        #expect(ComputerDeployRules.previewTag(scene(machine(available: false, browser: .off))) == .none)
        #expect(ComputerDeployRules.previewTag(scene()) == .none)
    }

    @Test("the preview follows the stream only while deployed and not asleep")
    func live() {
        #expect(ComputerDeployRules.previewIsLive(scene(machine(browser: .ready))))
        #expect(ComputerDeployRules.previewIsLive(scene(machine(browser: .starting))))
        #expect(ComputerDeployRules.previewIsLive(scene(machine(browser: .off))) == false)
        // Let it sleep in flight: the card under the full-screen view lets the stream go too.
        #expect(ComputerDeployRules.previewIsLive(scene(machine(), control: .sleeping)) == false)
        // Loading on a deployed server pulses; a server without it opens no socket.
        #expect(ComputerDeployRules.previewIsLive(scene(mode: .headless)))
        #expect(ComputerDeployRules.previewIsLive(scene(mode: .off)) == false)
        #expect(ComputerDeployRules.previewIsLive(scene(machine(available: false, browser: .ready))) == false)
    }
}

@Suite("Computer deploy: Let it sleep")
struct DataComputerSleepTests {
    @Test("shown while the browser is up or starting on a deployed computer")
    func shown() {
        #expect(ComputerDeployRules.sleepButton(scene(machine(browser: .ready)), status: nil) == .enabled)
        #expect(ComputerDeployRules.sleepButton(scene(machine(browser: .starting)), status: nil) == .enabled)
        #expect(ComputerDeployRules.sleepButton(scene(machine(browser: .off)), status: nil) == .hidden)
        #expect(ComputerDeployRules.sleepButton(scene(mode: .off, machine()), status: nil) == .hidden)
        #expect(ComputerDeployRules.sleepButton(scene(machine(available: false)), status: nil) == .hidden)
        #expect(ComputerDeployRules.sleepButton(scene(), status: nil) == .hidden)
    }

    @Test("disabled while OpenDuet works, the user drives or another request runs")
    func disabled() {
        #expect(ComputerDeployRules.sleepButton(scene(machine()), status: .workingBrowser) == .disabled)
        #expect(ComputerDeployRules.sleepButton(scene(machine(controller: .user)), status: nil) == .disabled)
        #expect(ComputerDeployRules.sleepButton(scene(machine(), control: .taking), status: nil) == .disabled)
        #expect(ComputerDeployRules.sleepButton(scene(machine(), control: .releasing), status: nil) == .disabled)
    }

    @Test("a spinner while it runs; a failure leaves it usable (the reason shows inline)")
    func busyAndFailed() {
        #expect(ComputerDeployRules.sleepButton(scene(machine(), control: .sleeping), status: nil) == .busy)
        #expect(ComputerDeployRules.sleepButton(scene(machine(), control: .failed(reason: "Busy")), status: nil) == .enabled)
    }

    @Test("only Take over / Hand back spin the capsule")
    func toggling() {
        #expect(ComputerDeployRules.isToggling(scene(machine(), control: .taking)))
        #expect(ComputerDeployRules.isToggling(scene(machine(), control: .releasing)))
        #expect(ComputerDeployRules.isToggling(scene(machine(), control: .sleeping)) == false)
        #expect(ComputerDeployRules.isToggling(scene(machine())) == false)
    }
}

@Suite("Computer deploy: the full-screen view")
struct DataComputerFullScreenTests {
    @Test("it rests only when Let it sleep answers with the browser off")
    func startsResting() {
        #expect(ComputerDeployRules.startsResting(from: .sleeping, to: .idle, browser: .off))
        #expect(ComputerDeployRules.startsResting(from: .sleeping, to: .idle, browser: .ready) == false)
        #expect(ComputerDeployRules.startsResting(from: .sleeping, to: .failed(reason: "Busy"), browser: .ready) == false)
        #expect(ComputerDeployRules.startsResting(from: .releasing, to: .idle, browser: .off) == false)
    }

    @Test("no stream while it rests, goes to sleep, or the server has no computer")
    func stream() {
        #expect(ComputerDeployRules.wantsStream(scene(machine()), resting: false))
        #expect(ComputerDeployRules.wantsStream(scene(machine(browser: .off)), resting: false))
        #expect(ComputerDeployRules.wantsStream(scene(mode: .headless), resting: false))
        #expect(ComputerDeployRules.wantsStream(scene(machine(browser: .off)), resting: true) == false)
        #expect(ComputerDeployRules.wantsStream(scene(machine(), control: .sleeping), resting: false) == false)
        #expect(ComputerDeployRules.wantsStream(scene(mode: .off), resting: false) == false)
        #expect(ComputerDeployRules.wantsStream(scene(machine(available: false)), resting: false) == false)
    }

    @Test("a browser coming up again ends it")
    func endsResting() {
        #expect(ComputerDeployRules.endsResting(browser: .starting))
        #expect(ComputerDeployRules.endsResting(browser: .ready))
        #expect(ComputerDeployRules.endsResting(browser: .off) == false)
        #expect(ComputerDeployRules.endsResting(browser: nil) == false)
    }

    @Test("the pill never says waking while it rests or isn't deployed")
    func pill() {
        let off = scene(machine(browser: .off))
        #expect(ComputerDeployRules.pill(off, status: nil, resting: false) == .waking)
        #expect(ComputerDeployRules.pill(off, status: nil, resting: true) == .idle)
        #expect(ComputerDeployRules.pill(off, status: .thinking, resting: true) == .status(.thinking))
        #expect(ComputerDeployRules.pill(scene(mode: .off, machine(browser: .off)), status: nil, resting: false) == .idle)
        #expect(ComputerDeployRules.pill(scene(machine(controller: .user)), status: nil, resting: true) == .inControl)
    }

    @Test("mode off shows isn't set up at once")
    func body() {
        #expect(ComputerDeployRules.body(scene(mode: .off)) == .unavailable)
        #expect(ComputerDeployRules.body(scene(mode: .off, machine())) == .unavailable)
        #expect(ComputerDeployRules.body(scene(mode: .headless)) == .loading)
        #expect(ComputerDeployRules.body(scene(machine(browser: .off))) == .waking)
        #expect(ComputerDeployRules.body(scene(machine())) == .screen)
    }

    @Test("Take over needs the screen on a deployed computer that isn't resting; Hand back always")
    func toggle() {
        #expect(ComputerDeployRules.canToggleControl(scene(machine()), resting: false))
        #expect(ComputerDeployRules.canToggleControl(scene(machine()), resting: true) == false)
        #expect(ComputerDeployRules.canToggleControl(scene(mode: .off, machine()), resting: false) == false)
        #expect(ComputerDeployRules.canToggleControl(scene(machine(browser: .off)), resting: false) == false)
        #expect(ComputerDeployRules.canToggleControl(scene(machine(controller: .user)), resting: true))
        #expect(ComputerDeployRules.canToggleControl(scene(machine(), control: .sleeping), resting: false) == false)
    }

    @Test("after Let it sleep only a deliberate wake or the browser coming up ends the stream hold; a view attaching doesn't")
    func streamHold() {
        #expect(ComputerDeployRules.holdsStream(true, after: .viewAttached))
        #expect(ComputerDeployRules.holdsStream(false, after: .viewAttached) == false)
        #expect(ComputerDeployRules.holdsStream(true, after: .state(.off)))
        #expect(ComputerDeployRules.holdsStream(true, after: .state(.starting)) == false)
        #expect(ComputerDeployRules.holdsStream(true, after: .state(.ready)) == false)
        #expect(ComputerDeployRules.holdsStream(true, after: .tappedWake) == false)
        #expect(ComputerDeployRules.holdsStream(true, after: .openedFullScreen) == false)
        #expect(ComputerDeployRules.holdsStream(false, after: .state(.off)) == false)
    }
}
