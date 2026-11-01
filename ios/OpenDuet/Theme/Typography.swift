// Fonts (prompt L83, L88). UI text is SF Pro, which falls back to PingFang SC for Chinese
// automatically. Serif titles use the system serif; Chinese uses Songti SC semibold when the
// device has it (the system serif renders Chinese in a sans face), else PingFang SC semibold.
import SwiftUI
import UIKit

enum Typography {
    /// True when the app is running in Simplified Chinese (per-app language included).
    static var isChinese: Bool {
        Bundle.main.preferredLocalizations.first?.hasPrefix("zh") ?? false
    }

    /// The heavy compact serif used by onboarding titles and serif titles across the app.
    static func serifTitle(_ size: CGFloat) -> Font {
        guard isChinese else { return .system(size: size, weight: .semibold, design: .serif) }
        if UIFont.familyNames.contains("Songti SC") {
            return .custom("STSongti-SC-Bold", fixedSize: size)
        }
        return .custom("PingFangSC-Semibold", fixedSize: size)
    }

    /// The assistant and user bubbles: 17 pt at the default text size. The bubble view (M2) scales it
    /// with Dynamic Type through @ScaledMetric (L187); this constant alone is fixed.
    static let bubble = Font.system(size: 17, weight: .regular)
    /// Status pill: 13 pt.
    static let pill = Font.system(size: 13, weight: .medium)
    /// Small grey system lines and captions.
    static let systemLine = Font.system(size: 13, weight: .regular)
    /// Chat captions (receipts, file sizes, the footer, failure lines): the caption text style,
    /// 12 pt regular at the default size, scaling with Dynamic Type (L187).
    static let caption = Font.caption
}
