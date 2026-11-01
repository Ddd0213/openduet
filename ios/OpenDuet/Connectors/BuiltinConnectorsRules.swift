// M25 (W2): the "Built in" rows of Settings › Apps and connectors without SwiftUI (host-tested):
// each built-in's own name and icon, the grey line saying what it sends where (the server's
// `providers` as sent), Open-Meteo's credit, and the status line by state. Read-only: a
// built-in is turned off only in the server's .env (BUILTIN_CONNECTORS_OFF).
import Foundation

enum BuiltinConnectorCopy {
    static func title(_ kind: BuiltinConnector.Kind) -> LocalizedStringResource {
        switch kind {
        case .webSearch: "Web search"
        case .weather: "Weather"
        case .exchangeRate: "Exchange rates"
        case .readFeed: "News feeds"
        }
    }

    /// SF Symbols for the row's tile.
    static func symbol(_ kind: BuiltinConnector.Kind) -> String {
        switch kind {
        case .webSearch: "magnifyingglass"
        case .weather: "cloud.sun"
        case .exchangeRate: "arrow.left.arrow.right"
        case .readFeed: "newspaper"
        }
    }

    /// What it sends where. Web search names the providers in the order tried; with none (it is
    /// off) there's no line. Weather and rates fall back to their only service while off.
    static func sends(_ connector: BuiltinConnector) -> LocalizedStringResource? {
        let providers = connector.providers.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        switch connector.kind {
        case .webSearch:
            guard let first = providers.first else { return nil }
            let rest = providers.dropFirst()
            if rest.isEmpty { return "Your search words go to \(first)." }
            return "Your search words go to \(first) (\(list(Array(rest))) when it's busy)."
        case .weather:
            return "The place name goes to \(providers.first ?? "Open-Meteo")."
        case .exchangeRate:
            return "The currency codes go to \(providers.first ?? "Frankfurter") (European Central Bank rates)."
        case .readFeed:
            return "OpenDuet reads the feed from its own site."
        }
    }

    /// Open-Meteo's CC BY 4.0 credit, on the weather row only.
    static func credit(_ kind: BuiltinConnector.Kind) -> LocalizedStringResource? {
        kind == .weather ? "Weather data by Open-Meteo.com" : nil
    }

    /// off / unreachable get a line; on and a state from a newer server get none.
    static func status(_ state: BuiltinConnector.State?) -> LocalizedStringResource? {
        switch state {
        case .off?: "Turned off on this server"
        case .unreachable?: "Can't be reached right now"
        case .on?, nil: nil
        }
    }

    /// Proper names joined for the current language ("Parallel", "Parallel and Brave").
    static func list(_ names: [String], locale: Locale = .current) -> String {
        names.formatted(.list(type: .and).locale(locale))
    }
}
