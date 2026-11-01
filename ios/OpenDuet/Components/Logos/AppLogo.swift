// An app's mark by Composio toolkit slug (the slug only picks the mark; the UI always
// shows the display name). OpenDuet's computer draws the set's computer; unknown toolkits get the
// hand-drawn monogram (M9: the initial in the serif over a soft clay print with a small inked
// stroke under it), and only when the name starts with a letter; anything else ("[CL]", "42")
// draws the apps grid. M4 swaps in the server's logo (Connector.logoUrl) where one exists.
import SwiftUI

struct AppLogo: View {
    var toolkit: String?
    /// Display name, used for the fallback's initial.
    var name: String = ""
    var size: CGFloat = 14
    /// The fallback monogram draws its own tile-surface ring; a tile (IconTile, ConnectorLogo)
    /// already frames it, so it asks for the bare mark.
    var framed = true

    /// Slugs of the assistant's own computer: the toolkit id, and CardFormat.toolkitSlug of its
    /// display names ("OpenDuet's computer", "OpenDuet 的电脑"; M29: the old "Claude's computer",
    /// "Claude 的电脑" stay for cards already stored).
    static let computerSlugs: Set<String> = [
        "duet_computer", "duetcomputer", "openduetscomputer", "openduet的电脑", "claudescomputer", "claude的电脑", "computer",
    ]

    /// Toolkits with their own drawn brand mark below. M29: "claude" (the connector toolkit) stays
    /// here so its tile never shows a fetched logo, but draws the plain monogram, not Claude's mark.
    static let drawnSlugs: Set<String> = ["gmail", "googlecalendar", "googledrive", "googledocs", "github", "slack", "cloudflare", "cloudinary", "excalidraw", "claude"]

    /// The monogram's letter: the name's first character, only when it is a letter (any script).
    static func monogramLetter(_ name: String) -> String? {
        guard let first = name.trimmingCharacters(in: .whitespacesAndNewlines).first, first.isLetter else { return nil }
        return String(first).uppercased()
    }

    var body: some View {
        mark
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    @ViewBuilder private var mark: some View {
        switch toolkit?.lowercased() {
        case "gmail": GmailMark()
        case "googlecalendar": CalendarMark()
        case "googledrive", "googledocs": DriveMark()
        case "github": GitHubMark()
        case "slack": SlackMark()
        case "cloudflare": symbol("cloud.fill", color: 0xF38020)
        case "cloudinary": symbol("cloud.fill", color: 0x3448C5)
        case "excalidraw": symbol("scribble.variable", color: 0x6965DB)
        case let slug? where Self.computerSlugs.contains(slug):
            DuetArtGlyph(art: .computer, symbol: DuetGlyph.computer.symbol, size: size)
        default: fallback
        }
    }

    private func symbol(_ name: String, color: UInt32) -> some View {
        Image(systemName: name)
            .resizable()
            .scaledToFit()
            .foregroundStyle(Color(hex: color))
    }

    /// The monogram, on a tile-surface ring when it stands alone, bare inside a tile.
    @ViewBuilder private var fallback: some View {
        ZStack {
            if framed {
                TileSurface(shape: Circle())
            }
            let inner = framed ? size * 0.62 : size
            if let letter = Self.monogramLetter(name) {
                DuetMonogram(letter: letter, size: inner, ink: Palette.tileGlyph, accent: inner >= ArtStyle.accentMinSize ? Palette.artAccent : nil)
            } else {
                DuetArtGlyph(art: .grid, symbol: DuetGlyph.moreApps.symbol, size: inner * 0.9)
            }
        }
    }
}

#Preview {
    HStack(spacing: 12) {
        ForEach(["gmail", "googlecalendar", "googledrive", "github", "slack", "cloudflare", "notion", "openduetscomputer", "claude"], id: \.self) {
            AppLogo(toolkit: $0, name: $0, size: 28)
        }
    }
    .padding()
}
