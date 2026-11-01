// The reverse map: SF Symbol names the shared tiles still take (IconTile, RowSymbol,
// EmptyStateView, FileGlyphTile, CircleIconButton) to the drawing that replaces them, so every
// existing call site gets the hand-drawn set with no edits. Grepped app-wide (M9): literal
// strings, DuetGlyph.x.symbol, RunGlyph, AccessCategory.systemImage, TaskResource.Kind.glyph,
// FileKind.glyph, approval bodies, ChannelIcon.systemImage.
import SwiftUI

extension DuetArt {
    /// The drawing for an SF Symbol name; nil when the set has none (the caller keeps the symbol).
    /// ".fill" variants map to their outline drawing.
    init?(symbol: String) {
        if let art = Self.symbols[symbol] {
            self = art
        } else if symbol.hasSuffix(".fill"), let art = Self.symbols[String(symbol.dropLast(5))] {
            self = art
        } else {
            return nil
        }
    }

    static let symbols: [String: DuetArt] = [
        // Documents and files
        "doc": .file, "doc.text": .doc, "doc.plaintext": .doc, "doc.richtext": .doc, "text.page": .doc,
        "doc.on.doc": .pages, "doc.zipper": .zipDoc, "tablecells": .sheetGrid,
        "rectangle.on.rectangle": .slides, "folder": .folder, "archivebox": .archive, "tray": .tray,
        "square.on.square": .stack, "cube": .cube, "photo": .photo, "photo.on.rectangle": .photo,
        // Work
        "lightbulb": .bulb, "checklist": .tasks, "checkmark.square": .checkbox, "calendar": .calendar,
        "clock": .clock, "timer": .timer, "sun.horizon": .sunrise, "chart.bar": .bars,
        "chart.bar.xaxis": .bars, "chart.line.uptrend.xyaxis": .chartLine, "paintbrush": .brush,
        "paintbrush.pointed": .brush, "briefcase": .briefcase, "play.rectangle": .playScreen,
        "square.stack.3d.up": .layers, "testtube.2": .flask,
        // Talk and people
        "envelope": .envelope, "bubble.left": .bubble, "bubble.left.and.bubble.right": .bubbles,
        "text.bubble": .replyBubble, "ellipsis.bubble": .thinkBubble, "questionmark.circle": .question,
        "person": .person, "person.crop.circle": .personCircle, "person.2": .people,
        "paperplane": .paperPlane, "arrowshape.turn.up.left": .quote,
        // Web and search
        "link": .link, "globe": .globe, "safari": .window, "macwindow": .window,
        "magnifyingglass": .magnifier, "eye": .eye, "wifi.slash": .wifiOff,
        // Money and places
        "creditcard": .card, "dollarsign.circle": .coin, "banknote": .banknote, "cart": .cart,
        "bag": .bag, "gift": .gift, "mappin": .mapPin, "mappin.and.ellipse": .mapPin,
        "house": .house, "airplane": .plane, "car": .car,
        // Things
        "book": .book, "book.closed": .notebook, "camera": .camera, "music.note": .music,
        "mic": .mic, "waveform": .waveform, "keyboard": .keyboard, "scissors": .scissors,
        "leaf": .sprout, "heart": .heart, "star": .star, "bell": .bell, "bell.slash": .bellOff,
        "sparkle": .sparkle, "sparkles": .sparkle, "pin": .pin,
        // Apps and tools
        "display": .computer, "desktopcomputer": .computer, "square.grid.2x2": .grid,
        "wrench.and.screwdriver": .wrench, "wrench.adjustable": .wrench, "wrench": .wrench,
        "terminal": .terminal, "chevron.left.forwardslash.chevron.right": .code,
        "cylinder.split.1x2": .database, "paperclip": .paperclip, "checkmark.seal": .seal,
        "checkmark.shield": .shield, "hand.raised": .stamp, "hand.raised.circle": .stamp,
        "signature": .signature, "trash": .trash, "pencil": .pencil, "square.and.pencil": .make,
        "square.and.arrow.up": .share, "arrow.clockwise": .refresh, "cursorarrow": .pointer,
        "arrow.up.arrow.down": .sort, "list.bullet": .contents, "line.3.horizontal.decrease": .menu,
        // Marks and status
        "exclamationmark.triangle": .warning, "checkmark": .check, "checkmark.circle": .done,
        "exclamationmark.circle": .failed, "circle.dashed": .pending, "info.circle": .info,
        "arrow.forward.circle": .action, "arrow.up.right": .arrowOut, "arrow.up.forward": .arrowOut,
        "play": .play, "slash.circle": .slashCircle, "bolt": .action,
        // Chrome
        "plus": .plus, "xmark": .close, "chevron.right": .chevronRight, "chevron.left": .chevronLeft,
        "arrow.down": .arrowDown, "ellipsis": .ellipsis,
    ]

    /// Chrome primitives that stay SF Symbols in chrome slots (header circles, menus).
    static let chromeSymbols: Set<String> = ["xmark", "chevron.left", "chevron.right", "chevron.down", "ellipsis", "plus", "arrow.down", "arrow.up", "checkmark"]
}
