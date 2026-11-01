// M17: one MCP Registry template in Add connector's gallery: its logo (a drawn mark, else its
// https icon, else the title's monogram), the title, one line of description with the hint the
// server learned ("Signs in" / "Nothing to fill in"), and Add (a spinner while it installs) or
// "Added" (the row opens that connector). A failed install's reason sits under the row.
import SwiftUI
import UIKit

struct TemplateRow: View {
    var template: ConnectorTemplate
    var state: TemplateRowState
    var failure: String?
    var onAdd: () -> Void
    var onOpen: () -> Void

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var lineSize: CGFloat = 13.5

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if case .added = state {
                Button(action: onOpen) { row }
                    .buttonStyle(RowPressStyle())
                    .accessibilityElement(children: .combine)
                    .accessibilityHint(Text("Opens the connector"))
            } else {
                row
            }
            if let failure {
                SettingsReasonLine(reason: failure)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: failure)
        .animation(.easeInOut(duration: 0.2), value: state)
    }

    private var row: some View {
        HStack(spacing: 12) {
            TemplateLogo(template: template, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: template.title)
                    .font(.system(size: titleSize, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(1)
                line
                    .font(.system(size: lineSize))
                    .foregroundStyle(Palette.secondaryText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: Metrics.sheetRowMinHeight)
        .contentShape(Rectangle())
    }

    /// "Tasks and projects · Signs in": the description cut to one line, the hint always shown.
    @ViewBuilder private var line: some View {
        let description = template.description.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let hint = TemplateHint.of(template)
        if !description.isEmpty || hint != nil {
            HStack(spacing: 4) {
                if !description.isEmpty {
                    Text(verbatim: description)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                if let hint {
                    if !description.isEmpty { Text(verbatim: "·").accessibilityHidden(true) }
                    Text(hint.text)
                        .lineLimit(1)
                        .fixedSize()
                        .transition(.opacity)
                }
            }
        }
    }

    @ViewBuilder private var trailing: some View {
        switch state {
        case .add:
            SmallCapsule(title: Text("Add"), action: onAdd)
                .accessibilityLabel(Text("Add \(template.title)"))
        case .installing:
            ProgressView()
                .controlSize(.small)
                .frame(minWidth: 52, minHeight: 30)
                .accessibilityLabel(Text("Adding"))
        case .added:
            Text("Added")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.success)
        }
    }
}

/// The compact dark capsule of a list row ("Add").
struct SmallCapsule: View {
    var title: Text
    var action: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 13.5

    var body: some View {
        Button(action: action) {
            title
                .font(.system(size: fontSize, weight: .semibold))
                .foregroundStyle(Palette.filledButtonText)
                .lineLimit(1)
                .padding(.horizontal, 14)
                .frame(minHeight: 30)
                .background(Capsule().fill(Palette.filledButton))
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.94))
    }
}

/// A template's mark: the app's drawn mark when it has one for the name, else its https icon
/// (fetched without the server's session: no token goes to the icon's host), else the monogram.
struct TemplateLogo: View {
    var template: ConnectorTemplate
    var size: CGFloat

    var body: some View {
        Color.clear
            .frame(width: size, height: size)
            .tileBackground(corner: size * ArtStyle.tileCornerRatio)
            .overlay { mark }
            .accessibilityHidden(true)
    }

    private var drawn: String? {
        let slug = TemplateLogo.slug(template)
        return AppLogo.drawnSlugs.contains(slug) ? slug : nil
    }

    @ViewBuilder private var mark: some View {
        if let drawn {
            AppLogo(toolkit: drawn, name: template.title, size: size * ArtStyle.tileArtRatio, framed: false)
        } else if let icon = template.iconUrl.flatMap(URL.init(string:)), icon.scheme?.lowercased() == "https" {
            RemoteIcon(url: icon) {
                AppLogo(toolkit: nil, name: template.title, size: size * ArtStyle.tileArtRatio, framed: false)
            }
            .frame(width: size * 0.62, height: size * 0.62)
        } else {
            AppLogo(toolkit: nil, name: template.title, size: size * ArtStyle.tileArtRatio, framed: false)
        }
    }

    /// "com.github/mcp" / "GitHub" → "github" (the drawn marks' slugs are lower-case brand names).
    static func slug(_ template: ConnectorTemplate) -> String {
        template.title.lowercased().filter { $0.isLetter || $0.isNumber }
    }
}

/// An image from a public https address (a registry icon), with no credentials: a plain GET, a
/// 15 s deadline, at most 512 KB, kept in memory for the session. `fallback` while it loads or
/// when it fails (SVG and other formats UIImage can't read included).
struct RemoteIcon<Fallback: View>: View {
    var url: URL
    @ViewBuilder var fallback: () -> Fallback

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .transition(.opacity)
            } else {
                fallback()
            }
        }
        .task(id: url) { await load() }
    }

    private func load() async {
        let key = "remote-icon:" + url.absoluteString
        if let cached = ImageMemoryCache.shared.image(for: key) {
            image = cached
            return
        }
        var request = URLRequest(url: url)
        request.setValue("image/png, image/jpeg, image/webp, image/*;q=0.8", forHTTPHeaderField: "Accept")
        guard let answer = try? await RemoteIconSession.shared.data(for: request) else { return }
        let (data, response) = answer
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              data.count <= 512 * 1024 else { return }
        let decoded = await Task.detached(priority: .utility) { UIImage(data: data)?.preparingForDisplay() }.value
        guard !Task.isCancelled, let decoded else { return }
        ImageMemoryCache.shared.insert(decoded, for: key)
        withAnimation(.easeInOut(duration: 0.2)) { image = decoded }
    }
}

/// The icons' own session: ephemeral, no cookies, no credentials, nothing of the server's.
private enum RemoteIconSession {
    static let shared: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()
}
