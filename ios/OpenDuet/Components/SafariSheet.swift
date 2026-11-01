// http(s) links open in an in-app Safari sheet (prompt L183), tinted with the accent.
import SafariServices
import SwiftUI

/// An http(s) URL to present; Identifiable for `.sheet(item:)`.
struct SafariLink: Identifiable, Hashable {
    var url: URL
    var id: URL { url }

    /// Only web links can open in Safari; anything else is nil.
    init?(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        self.url = url
    }
}

struct SafariView: UIViewControllerRepresentable {
    var url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.preferredControlTintColor = UIColor(hex: 0xC7604A)
        controller.dismissButtonStyle = .close
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
