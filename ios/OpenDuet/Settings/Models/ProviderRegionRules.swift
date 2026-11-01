// M27: StepFun's region (mainland China / international) and the provider forms' rows, without
// SwiftUI for the host tests. The regions and their hosts come from the server
// (VoiceSettings.presets); a kind the presets give no regions has no Region row. Gemini and
// StepFun have no Base URL row: the address follows the kind and the region. A Gemini or StepFun
// provider whose address isn't its region's host (a proxy set before M27) shows it read-only.
import Foundation

extension ProviderRegion {
    /// The region's name in the app.
    var label: LocalizedStringResource {
        switch self {
        case .cn: "Mainland China"
        case .intl: "International"
        }
    }

    /// The other site (two regions).
    var other: ProviderRegion {
        switch self {
        case .cn: .intl
        case .intl: .cn
        }
    }
}

extension VoiceEngineKind {
    /// The provider kind of a voice engine.
    var providerKind: ProviderKind {
        switch self {
        case .gemini: .gemini
        case .stepfun: .stepfun
        }
    }

    /// The preset's name ("Google Gemini", "StepFun").
    var title: LocalizedStringResource { providerKind.title }
}

/// One choice of the Region row: the region and the host it talks to (nil when unknown).
struct ProviderRegionOption: Hashable, Sendable {
    var region: ProviderRegion
    var host: String?
}

/// A 400 that says the key belongs to the other site, and what the app offers.
struct WrongSite: Hashable, Sendable {
    /// the site the key works on
    var belongsTo: ProviderRegion
    /// "Switch to <it>" (nil: the provider already is there, nothing to switch)
    var switchTo: ProviderRegion?
}

enum ProviderRegionRules {
    /// The Region row's options for a kind, from the server's presets (none: no Region row; an
    /// older server or presets not loaded yet).
    static func options(for kind: ProviderKind, presets: [VoiceProviderPreset]) -> [ProviderRegionOption] {
        guard let preset = presets.first(where: { $0.kind.providerKind == kind }) else { return [] }
        return preset.regions.map { ProviderRegionOption(region: $0.region, host: $0.host) }
    }

    /// The host of a region in the options (nil when unknown).
    static func host(_ region: ProviderRegion?, in options: [ProviderRegionOption]) -> String? {
        guard let region else { return nil }
        return options.first { $0.region == region }?.host
    }

    /// A new StepFun provider's region from the iPhone's region: CN -> mainland China, any other
    /// country -> international; unknown -> nil (the server picks).
    static func defaultRegion(localeRegion: String?) -> ProviderRegion? {
        guard let code = localeRegion?.uppercased(), code.count == 2, code.allSatisfy(\.isLetter) else { return nil }
        return code == "CN" ? .cn : .intl
    }

    /// What the Region row shows before the user picks: the draft's, else the server's default
    /// for this phone, else mainland China (what the server picks for an unknown region).
    static func shownRegion(_ draft: ProviderRegion?, preset: ProviderRegion?) -> ProviderRegion {
        draft ?? preset ?? .cn
    }

    /// The server's default for a kind (VoiceProviderPreset.defaultRegion).
    static func presetDefault(for kind: ProviderKind, presets: [VoiceProviderPreset]) -> ProviderRegion? {
        presets.first { $0.kind.providerKind == kind }?.defaultRegion
    }

    /// A refused write whose 400 field is `region`: the key belongs to the other site. `tried` is
    /// the region the key was checked against, `saved` the provider's region now (nil while it's
    /// being added). Switching is offered unless the provider is already on that site.
    static func wrongSite(_ error: any Error, tried: ProviderRegion, saved: ProviderRegion?) -> WrongSite? {
        guard case APIError.validationFailed(let field, _)? = error as? APIError, field == "region" else { return nil }
        let belongs = tried.other
        return WrongSite(belongsTo: belongs, switchTo: belongs == saved ? nil : belongs)
    }

    /// The line for a wrong-site refusal (the app's own words, by field and code).
    static func wrongSiteText(_ wrong: WrongSite) -> String {
        switch (wrong.belongsTo, wrong.switchTo) {
        case (.intl, .some): String(localized: "This key is for StepFun's international site.")
        case (.cn, .some): String(localized: "This key is for StepFun's mainland China site.")
        case (.intl, nil): String(localized: "This key is for StepFun's international site, so the region stays International.")
        case (.cn, nil): String(localized: "This key is for StepFun's mainland China site, so the region stays Mainland China.")
        }
    }
}

/// The provider forms' rows (Add provider, a provider's Edit).
enum ProviderFormRow: Hashable, Sendable {
    case name, key, baseURL, region
    /// read-only: a proxy set before M27 on a kind whose address is fixed
    case address
}

enum ProviderFormLayout {
    /// Gemini and StepFun: the address follows the kind and the region (no Base URL row).
    static func hasFixedAddress(_ kind: ProviderKind) -> Bool {
        kind == .gemini || kind == .stepfun
    }

    /// Add provider: custom asks for the Base URL; a kind with regions gets the Region row.
    static func addRows(_ kind: ProviderKind, regions: [ProviderRegionOption]) -> [ProviderFormRow] {
        var rows: [ProviderFormRow] = []
        if kind == .custom { rows.append(.baseURL) }
        if !regions.isEmpty { rows.append(.region) }
        return rows + [.name, .key]
    }

    /// A provider's Edit: the Base URL for kinds whose address isn't fixed; Region for a kind
    /// with regions; a proxy's address read-only.
    static func editRows(_ provider: ModelProvider, regions: [ProviderRegionOption]) -> [ProviderFormRow] {
        var rows: [ProviderFormRow] = []
        if !regions.isEmpty { rows.append(.region) }
        rows += [.name, .key]
        if !hasFixedAddress(provider.kind) {
            rows.append(.baseURL)
        } else if isProxy(provider, regions: regions) {
            rows.append(.address)
        }
        return rows
    }

    /// A Gemini or StepFun provider whose host isn't its region's (a proxy set before M27). Without
    /// a known host there is nothing to compare: not a proxy (its address shows on the status line).
    static func isProxy(_ provider: ModelProvider, regions: [ProviderRegionOption]) -> Bool {
        guard hasFixedAddress(provider.kind),
              let expected = ProviderRegionRules.host(provider.region, in: regions)?.lowercased(),
              let host = URLComponents(string: provider.baseUrl)?.host?.lowercased() else { return false }
        return host != expected
    }
}
