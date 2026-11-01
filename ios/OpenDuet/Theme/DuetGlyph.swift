// One semantic name per icon concept (M8): every screen asks for a concept, and this file
// alone decides which symbol (and weight) draws it, so the whole app's icons stay one
// consistent, refined monochrome set. Call sites use `DuetGlyph.x.symbol` (or `Image(glyph:)`).
//
// M9: visible icons are the hand-drawn set (Components/Icons, `art` below), drawn by DuetIcon
// and the shared tiles. `symbol` stays the closest SF Symbol: menus, Labels and `.contextMenu`
// (UIKit needs symbols), and the fallback for a concept without a drawing. `weight(for:)`
// tunes the SF Symbols that remain (chrome, menus) to the set's stroke.
import SwiftUI

enum DuetGlyph: String, CaseIterable, Sendable {
    // Apps and access (OpenDuet sheet, connectors)
    case files, mail, calendar, teamChat, payments, computer, moreApps, notSetUp
    // Work and tasks
    case task, doc, clock, update, resource, link, browser, artifact, suggestion, confirmation, tray
    // Run record steps
    case command, page, search, read, write, fileList, memory, thinking, reply, tool, approval, error, sent
    // Approval kinds
    case email, payment, signature, delete, action
    // Shell and chrome
    case menu, back, close, more, edit, share, refresh, pointer, sources, contents, scrollDown, quote, voice, dictate
    // M8 visual pass: tabs, menus and small marks
    case chat, tasks, make, pin, add, check, sort, attach, camera, photos, copy, comment, exportPDF
    case addToTabBar, removeFromTabBar, archive, profile, offline, info, timer, play, skill, keyboard
    case warning, done, failed, pending, forward, chevron, eye

    /// The SF Symbol drawing this concept. Tuned centrally by the visual pass.
    var symbol: String {
        switch self {
        case .files: "doc.text"
        case .mail: "envelope"
        case .calendar: "calendar"
        case .teamChat: "bubble.left.and.bubble.right"
        case .payments: "creditcard"
        // A clean outline display, never the filled desktop tower.
        case .computer: "display"
        case .moreApps: "square.grid.2x2"
        case .notSetUp: "wrench.and.screwdriver"
        case .task: "checklist"
        case .doc: "doc.text"
        case .clock: "clock"
        case .update: "arrow.up.right"
        case .resource: "paperclip"
        case .link: "link"
        // A neutral window, not another browser's brand.
        case .browser: "macwindow"
        case .artifact: "square.on.square"
        case .suggestion: "lightbulb"
        case .confirmation: "checkmark.seal"
        case .tray: "tray"
        case .command: "terminal"
        case .page: "globe"
        case .search: "magnifyingglass"
        case .read: "text.page"
        case .write: "square.and.pencil"
        case .fileList: "folder"
        case .memory: "book.closed"
        case .thinking: "ellipsis.bubble"
        case .reply: "text.bubble"
        case .tool: "wrench.adjustable"
        case .approval: "hand.raised"
        case .error: "exclamationmark.triangle"
        case .sent: "paperplane"
        case .email: "envelope"
        case .payment: "creditcard"
        case .signature: "signature"
        case .delete: "trash"
        // A generic action: an arrow in a circle reads "run this" without the cheap bolt.
        case .action: "arrow.forward.circle"
        case .menu: "line.3.horizontal.decrease"
        case .back: "chevron.left"
        case .close: "xmark"
        case .more: "ellipsis"
        case .edit: "pencil"
        case .share: "square.and.arrow.up"
        case .refresh: "arrow.clockwise"
        case .pointer: "cursorarrow"
        case .sources: "cylinder.split.1x2"
        case .contents: "list.bullet"
        case .scrollDown: "arrow.down"
        case .quote: "arrowshape.turn.up.left"
        case .voice: "waveform"
        case .dictate: "mic"
        case .chat: "bubble.left"
        case .tasks: "checklist"
        case .make: "square.and.pencil"
        case .pin: "pin"
        case .add: "plus"
        case .check: "checkmark"
        case .sort: "arrow.up.arrow.down"
        case .attach: "paperclip"
        case .camera: "camera"
        case .photos: "photo.on.rectangle"
        case .copy: "doc.on.doc"
        case .comment: "text.bubble"
        case .exportPDF: "doc.richtext"
        case .addToTabBar: "rectangle.badge.plus"
        case .removeFromTabBar: "rectangle.badge.minus"
        case .archive: "archivebox"
        case .profile: "person"
        case .offline: "wifi.slash"
        case .info: "info.circle"
        case .timer: "timer"
        case .play: "play"
        case .skill: "slash.circle"
        case .keyboard: "keyboard"
        case .warning: "exclamationmark.triangle"
        case .done: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .pending: "circle.dashed"
        case .forward: "arrow.up.forward"
        case .chevron: "chevron.right"
        case .eye: "eye"
        }
    }

    /// The weight that keeps one optical stroke across sizes: small marks a little heavier so
    /// they hold up, large tile and empty-state glyphs lighter so they never look clip-art bold.
    static func weight(for size: CGFloat) -> Font.Weight {
        switch size {
        case ..<13: .semibold
        case ..<19: .medium
        case ..<27: .regular
        default: .light
        }
    }
}

extension DuetGlyph {
    /// The hand-drawn drawing for the concept (M9, Components/Icons). nil = no drawing: DuetIcon
    /// falls back to `symbol` (only the two tab-bar menu actions, which live in menus anyway).
    var art: DuetArt? {
        switch self {
        case .files, .doc, .read: .doc
        case .mail, .email: .envelope
        case .calendar: .calendar
        case .teamChat: .bubbles
        case .payments, .payment: .card
        case .computer: .computer
        case .moreApps: .grid
        case .notSetUp, .tool: .wrench
        case .task, .tasks: .tasks
        case .clock: .clock
        case .update, .forward: .arrowOut
        case .resource, .attach: .paperclip
        case .link: .link
        case .browser: .window
        case .artifact: .stack
        case .suggestion: .bulb
        case .confirmation: .seal
        case .tray: .tray
        case .command: .terminal
        case .page: .globe
        case .search: .magnifier
        case .write: .compose
        case .fileList: .folder
        case .memory: .notebook
        case .thinking: .thinkBubble
        case .reply, .comment: .replyBubble
        case .approval: .stamp
        case .error, .warning: .warning
        case .sent: .paperPlane
        case .signature: .signature
        case .delete: .trash
        case .action: .action
        case .menu: .menu
        case .back: .chevronLeft
        case .close: .close
        case .more: .ellipsis
        case .edit: .pencil
        case .share: .share
        case .refresh: .refresh
        case .pointer: .pointer
        case .sources: .database
        case .contents: .contents
        case .scrollDown: .arrowDown
        case .quote: .quote
        case .voice: .waveform
        case .dictate: .mic
        case .chat: .chat
        case .make: .make
        case .pin: .pin
        case .add: .plus
        case .check: .check
        case .sort: .sort
        case .camera: .camera
        case .photos: .photo
        case .copy: .pages
        case .exportPDF: .doc
        case .archive: .archive
        case .profile: .person
        case .offline: .wifiOff
        case .info: .info
        case .timer: .timer
        case .play: .play
        case .skill: .slashCircle
        case .keyboard: .keyboard
        case .done: .done
        case .failed: .failed
        case .pending: .pending
        case .chevron: .chevronRight
        case .eye: .eye
        case .addToTabBar, .removeFromTabBar: nil
        }
    }
}

extension CardIcon {
    /// The hand-drawn drawing for a card key the assistant picked (every key has one).
    var art: DuetArt {
        switch self {
        case .lightbulb: .bulb
        case .doc: .doc
        case .dashboard: .gauge
        case .slides: .slides
        case .webpage: .window
        case .design: .brush
        case .checklist: .checklist
        case .task: .clipboard
        case .calendar: .calendar
        case .clock: .clock
        case .mail: .envelope
        case .chat: .bubble
        case .person: .person
        case .people: .people
        case .folder: .folder
        case .file: .file
        case .link: .link
        case .search: .magnifier
        case .globe: .globe
        case .chart: .chartLine
        case .money: .banknote
        case .cart: .cart
        case .gift: .gift
        case .pin: .mapPin
        case .house: .house
        case .plane: .plane
        case .book: .book
        case .code: .code
        case .sparkle: .sparkle
        case .heart: .heart
        case .star: .star
        case .bell: .bell
        case .warning: .warning
        case .check: .check
        case .question: .question
        case .pencil: .pencil
        case .music: .music
        case .camera: .camera
        }
    }
}

extension Image {
    /// The concept's SF Symbol: for menus, Labels and `.contextMenu` (UIKit needs symbols).
    /// Visible content icons go through DuetIcon, which draws the hand-drawn set.
    init(glyph: DuetGlyph) { self.init(systemName: glyph.symbol) }
}

extension View {
    /// A symbol at `size` with the weight of the set (`DuetGlyph.weight(for:)`).
    func glyphFont(_ size: CGFloat, weight: Font.Weight? = nil) -> some View {
        font(.system(size: size, weight: weight ?? DuetGlyph.weight(for: size)))
    }
}
