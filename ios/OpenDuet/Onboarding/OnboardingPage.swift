// The six onboarding pages and their copy (prompt L19-L31). English keeps PART A's exact
// line breaks: the "\n" is part of the English source string. Chinese wraps naturally.
import Foundation

enum OnboardingPage: Int, CaseIterable, Identifiable, Sendable {
    case proactive, setup, web, safety, connect, notify

    var id: Int { rawValue }
    var next: OnboardingPage? { OnboardingPage(rawValue: rawValue + 1) }
    var previous: OnboardingPage? { OnboardingPage(rawValue: rawValue - 1) }

    var title: String {
        switch self {
        case .proactive: String(localized: "24/7 proactive help that\nkeeps tasks moving")
        case .setup: String(localized: "Already knows your setup")
        case .web: String(localized: "It gets things done\non the web, too")
        case .safety: String(localized: "Safe, private,\nand in your control")
        case .connect: String(localized: "Connect your apps")
        case .notify: String(localized: "Get notified")
        }
    }

    var body: String {
        switch self {
        case .proactive:
            String(localized: "OpenDuet notices what needs doing, does it\nin the background, and reaches out when it needs you.")
        case .setup:
            String(localized: "Your tools, projects, chats, memory, and skills come with your OpenDuet account.")
        case .web:
            String(localized: "OpenDuet works in its own browser. This lets it open\nsites and fill out forms for your to-do list.")
        case .safety:
            String(localized: "OpenDuet checks with you before big steps and stops\nwhen something looks wrong.")
        case .connect:
            String(localized: "This way OpenDuet can read what's new across apps, take action for you, and make sure you never miss a beat, with many more connectors available.")
        case .notify:
            String(localized: "Allow notifications so OpenDuet can tell you when tasks are done or your input is needed.")
        }
    }

    /// Small grey text above the buttons (page 2's usage note, page 4's fine print).
    var footer: (text: String, size: Double)? {
        switch self {
        case .setup: (String(localized: "OpenDuet uses your server's usage limits."), 12)
        case .safety:
            (String(localized: "OpenDuet works in the background. It reads your connected apps and can act in them on its own, without you asking. It can make mistakes, so check its work. You can turn off any connected app in Settings."), 11)
        default: nil
        }
    }

    enum Buttons: Sendable { case next, connect, notify }

    var buttons: Buttons {
        switch self {
        case .connect: .connect
        case .notify: .notify
        default: .next
        }
    }
}
