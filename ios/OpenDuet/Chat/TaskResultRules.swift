// M18: when a task's result bubble folds (TaskResultBubble). A result longer than about 12 lines
// shows its first 12 with "Show more"; a result only a little longer shows whole (no toggle for
// one or two hidden lines). Pure Foundation, so the host tests run it.
import CoreGraphics
import Foundation

enum TaskResultFold {
    /// Lines shown while folded.
    static let visibleLines = 12
    /// Fold only when at least this many more lines would hide.
    static let minHiddenLines = 3
    /// Characters of Latin text on one bubble line (17 pt in an 80% slot of a ~390 pt phone);
    /// a CJK character counts as two.
    static let lineUnits = 34

    /// Lines the text roughly takes in the bubble, before it is laid out: each source line wraps
    /// at `lineUnits`, a blank line (a paragraph gap) counts half.
    static func estimatedLines(_ text: String) -> Double {
        var lines = 0.0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let units = line.unicodeScalars.reduce(0) { $0 + (isWide($1) ? 2 : 1) }
            lines += units == 0 ? 0.5 : (Double(units) / Double(lineUnits)).rounded(.up)
        }
        return lines
    }

    /// The first guess, until the bubble has measured its text.
    static func isLong(_ text: String) -> Bool {
        estimatedLines(text) >= Double(visibleLines + minHiddenLines)
    }

    /// Once measured: does the text of `height` points fold, with lines of `lineHeight`?
    static func folds(height: CGFloat, lineHeight: CGFloat) -> Bool {
        guard height > 0, lineHeight > 0 else { return false }
        return height > lineHeight * CGFloat(visibleLines + minHiddenLines)
    }

    /// The folded text's height.
    static func collapsedHeight(lineHeight: CGFloat) -> CGFloat {
        lineHeight * CGFloat(visibleLines)
    }

    /// CJK ideographs, kana, hangul and full-width forms take about two Latin letters' width.
    private static func isWide(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x1100...0x115F, 0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF, 0x4E00...0x9FFF,
             0xA000...0xA4CF, 0xAC00...0xD7A3, 0xF900...0xFAFF, 0xFE30...0xFE4F, 0xFF00...0xFF60,
             0xFFE0...0xFFE6, 0x20000...0x2FFFD:
            true
        default:
            false
        }
    }
}
