// M22 (#47) Setup, Language and Appearance without SwiftUI or UIKit, so the Mac host tests cover
// them: a row's status word (an unknown status reads Not checked), what its fix does (an in-sheet
// page, a link the shell opens, or backend/.env names to copy; nothing when ready or unknown),
// the phone's own Notifications row, Check again's failure line (429: "Try again in a moment"),
// the stored appearance choice and the language subtitle.
import Foundation

// MARK: - Server rows

/// The status word on a Setup row.
enum SetupRowStatus: Hashable, Sendable {
    case ready, notChecked, needsSetup

    /// nil (a status a newer server added) reads like not checked.
    init(_ status: SetupItem.Status?) {
        switch status {
        case .ready?: self = .ready
        case .needsSetup?: self = .needsSetup
        case .notChecked?, nil: self = .notChecked
        }
    }

    var label: LocalizedStringResource {
        switch self {
        case .ready: "Ready"
        case .notChecked: "Not checked"
        case .needsSetup: "Needs setup"
        }
    }
}

/// What a row's fix does on the phone.
enum SetupFixAction: Hashable, Sendable {
    /// a page of the settings sheet (duet://settings/<page>): pushed over Setup
    case page(DuetRoute.SettingsPage)
    /// another in-app link (duet://computer): the shell opens it
    case link(URL)
    /// server settings the app can't change: the names to copy and what to do
    case env(names: [String], hint: Phrase)

    /// nil when the row is ready, has no fix, or the fix is one this build doesn't know (an
    /// unknown kind, a route that isn't an in-app link, no names).
    init?(_ item: SetupItem) {
        guard SetupRowStatus(item.status) != .ready, let fix = item.fix else { return nil }
        switch fix {
        case .route(let route):
            guard let url = URL(string: route), let parsed = DuetRoute(url) else { return nil }
            if case .settings(let page) = parsed {
                self = .page(page)
            } else {
                self = .link(url)
            }
        case .env(let names, let hint):
            let clean = names.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            guard !clean.isEmpty else { return nil }
            self = .env(names: clean, hint: hint)
        case .unsupported:
            return nil
        }
    }

    /// The button on a row that opens its fix (none for env rows: the names are the fix).
    var buttonTitle: LocalizedStringResource? {
        switch self {
        case .page(.models): "Open Models"
        case .page(.apps): "Open Apps"
        case .page(.voice): "Open Voice"
        case .page(.setup), .page(.soul), .link: "Open"
        case .env: nil
        }
    }
}

// MARK: - This phone's notifications

/// The phone's notification permission (UNAuthorizationStatus, read by SetupModel).
enum NotificationAccess: Hashable, Sendable {
    /// authorized, provisional or ephemeral
    case on
    /// denied in iOS Settings
    case off
    /// never asked
    case undecided
}

/// The app's own first Setup row: only the phone knows its permission.
enum SetupNotificationsRow {
    /// nil while the permission is read.
    static func status(_ access: NotificationAccess?) -> SetupRowStatus {
        switch access {
        case .on?: .ready
        case .off?, .undecided?: .needsSetup
        case nil: .notChecked
        }
    }

    enum Action: Hashable, Sendable {
        /// never asked: the system's permission alert
        case ask
        /// turned off: iOS Settings (openNotificationSettings)
        case openSettings
    }

    /// "Turn on" when the permission isn't on; nothing while it's on or still being read.
    static func action(_ access: NotificationAccess?) -> Action? {
        switch access {
        case .off?: .openSettings
        case .undecided?: .ask
        case .on?, nil: nil
        }
    }
}

// MARK: - Check again

enum SetupCheckFailure {
    /// The inline line under Check again: 429 (a check in the last 30 s) says to wait a moment;
    /// anything else, the usual reason; nil when it was cancelled.
    static func line(for error: any Error) -> String? {
        if case APIError.rateLimited? = error as? APIError { return String(localized: "Try again in a moment") }
        return SettingsReason.line(for: error)
    }
}

// MARK: - Appearance

/// Everything → Appearance: System (the default, prompt L81) / Light / Dark, stored with
/// @AppStorage under `storageKey` and applied to the window (App/OpenDuetApp.swift).
enum AppearanceChoice: String, CaseIterable, Hashable, Sendable {
    case system, light, dark

    static let storageKey = "settings.appearance"

    /// The stored text; anything else (nothing stored, a value from a newer build) is System.
    init(stored: String?) {
        self = stored.flatMap(AppearanceChoice.init(rawValue:)) ?? .system
    }

    var label: LocalizedStringResource {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    /// False for System: the window follows the iPhone.
    var overridesSystem: Bool { self != .system }
}

// MARK: - Language

/// Everything → Language: the subtitle names the app's current language in that language
/// (as iOS's own language list does); the row opens iOS's page for the app, where the
/// per-app language is picked (prompt L87).
enum AppLanguageRow {
    /// From Bundle.main.preferredLocalizations (the same rule as RequestContext.locale).
    static func current(_ preferred: [String]) -> AppLanguage {
        preferred.first?.lowercased().hasPrefix("zh") == true ? .zhHans : .en
    }

    /// "简体中文" / "English", never translated.
    static func name(_ language: AppLanguage) -> String {
        switch language {
        case .zhHans: "简体中文"
        case .en: "English"
        }
    }
}
