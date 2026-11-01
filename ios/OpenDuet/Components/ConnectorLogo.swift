// A connector's mark in a rounded tile (prompt L125-L126, L168): the app's own drawn mark for
// the toolkits AppLogo knows, otherwise the server's logo (Connector.logoUrl, loaded through the
// signed-in session), otherwise the display name's hand-drawn monogram, on the app's one tile.
import SwiftUI

struct ConnectorLogo: View {
    var toolkit: String
    var name: String
    var logoUrl: String?
    var size: CGFloat = 36

    /// Toolkits with a drawn mark in AppLogo (kept in step with its switch).
    private static let drawn: Set<String> = AppLogo.drawnSlugs.union(AppLogo.computerSlugs)

    var body: some View {
        Color.clear
            .frame(width: size, height: size)
            .tileBackground(corner: size * ArtStyle.tileCornerRatio)
            .overlay { mark }
            .accessibilityHidden(true)
    }

    @ViewBuilder private var mark: some View {
        if Self.drawn.contains(toolkit.lowercased()) || logoUrl == nil {
            AppLogo(toolkit: toolkit, name: name, size: size * ArtStyle.tileArtRatio, framed: false)
        } else if let logoUrl {
            AuthenticatedImage(path: logoUrl) { phase, _ in
                switch phase {
                case .loaded(let image):
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: size * 0.6, height: size * 0.6)
                        .transition(.opacity)
                case .loading:
                    Color.clear
                case .failed:
                    AppLogo(toolkit: toolkit, name: name, size: size * ArtStyle.tileArtRatio, framed: false)
                }
            }
        }
    }
}

extension AccessCategory {
    /// The OpenDuet sheet's row title (L125).
    var title: LocalizedStringResource {
        switch self {
        case .files: "Files and docs"
        case .mail: "Mail"
        case .calendar: "Calendar"
        case .teamChat: "Team chat"
        case .payments: "Payments"
        }
    }

    /// The row's line while nothing of the category is connected (L125).
    var notConnected: LocalizedStringResource {
        switch self {
        case .files: "Can't read your files yet"
        case .mail: "Can't see your mail yet"
        case .calendar: "Can't see your schedule yet"
        case .teamChat: "Can't see your team chat yet"
        case .payments: "Can't make purchases yet"
        }
    }

    var systemImage: String {
        switch self {
        case .files: "doc.text"
        case .mail: "envelope"
        case .calendar: "calendar"
        case .teamChat: "bubble.left.and.bubble.right"
        case .payments: "creditcard"
        }
    }
}
