// The bubble long-press menu's overlay (M9, ref-bubble-menu-form.png), presented above the whole
// shell (header, side menu, task detail and tab bar included) by MainShellView:
// - the backdrop: the screen blurred and dimmed; tapping it closes;
// - the lifted bubble: a copy drawn at the bubble's frame that rises a touch (scale 1.03, soft
//   shadow) and moves only as far as needed so the bar and the card fit (tall bubbles are clipped
//   to what fits, with a fade);
// - the emoji bar above it (BubbleEmojiBar) and the menu card below or above it (BubbleMenuCard).
// In: the backdrop fades while the bubble lifts and the bar and card spring out of the bubble's
// edge (0.85 → 1 and opacity, the card a beat after the bar). Out: all of it reverses together and
// the copy settles back into the bubble's slot (where the bubble is now), then the bubble shows
// again. Reduce Motion: everything crossfades, nothing moves.
// It also hosts the sheets a row opens: the emoji picker, Select text and Share.
import SwiftUI
import UIKit

extension View {
    /// The bubble menu over this view (the shell root), fed by `center`.
    func bubbleMenuHost(_ center: BubbleMenuCenter) -> some View {
        modifier(BubbleMenuHost(center: center))
    }
}

private struct BubbleMenuHost: ViewModifier {
    @Bindable var center: BubbleMenuCenter

    func body(content: Content) -> some View {
        content
            .environment(\.bubbleMenu, center)
            .overlay {
                if let request = center.request {
                    BubbleMenuOverlay(request: request, center: center)
                        .id(request.id)
                }
            }
            .sheet(item: $center.sheet) { sheet in
                sheetContent(sheet)
                    // M10: whichever way the sheet went (UIKit closes the share sheet itself after
                    // a pick, without telling the binding), the center forgets it, so the next
                    // long press opens the menu again.
                    .onDisappear { center.sheetDisappeared(sheet.id) }
            }
    }

    @ViewBuilder
    private func sheetContent(_ sheet: BubbleMenuSheet) -> some View {
        switch sheet.kind {
        case .picker:
            EmojiPickerSheet(selected: sheet.selected) { emoji in
                sheet.react(emoji, !sheet.selected.contains(emoji))
                center.sheet = nil
            } onClose: { center.sheet = nil }
        case .selectText:
            SelectTextSheet(text: sheet.text) { center.sheet = nil }
        case .share:
            ActivitySheet(items: [sheet.text])
                .presentationDetents([.medium, .large])
        }
    }
}

private struct BubbleMenuOverlay: View {
    var request: BubbleMenuRequest
    var center: BubbleMenuCenter

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.chatExtras) private var extras
    @State private var shown = false
    @State private var closing = false
    /// Where the copy settles on the way out (the bubble's frame by then).
    @State private var home: CGRect?
    @State private var picks = 0
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var cardWidth: CGFloat = 250

    private var message: Message { request.message }

    var body: some View {
        GeometryReader { proxy in
            let origin = proxy.frame(in: .global).origin
            let layout = BubbleMenuLayout.make(
                origin: request.origin, bounds: proxy.size, insets: request.safeArea,
                cardSize: CGSize(width: cardWidth, height: BubbleMenuCard.height(rows: rows.count, dividers: dividers, rowHeight: rowHeight)),
                isAssistant: request.isAssistant
            )
            ZStack(alignment: .topLeading) {
                backdrop
                copy(layout: layout)
                    .offset(x: -origin.x, y: -origin.y)
                BubbleEmojiBar(selected: message.myReactions, onPick: pick, onMore: more)
                    .frame(width: layout.bar.width, height: layout.bar.height)
                    .scaleEffect(shown ? 1 : (reduceMotion ? 1 : 0.85), anchor: barAnchor)
                    .opacity(shown ? 1 : 0)
                    .animation(appear(delay: 0), value: shown)
                    .offset(x: layout.bar.minX - origin.x, y: layout.bar.minY - origin.y)
                BubbleMenuCard(rows: rows, dividerBefore: dividerIndex, rowHeight: rowHeight)
                    .frame(width: layout.card.width, height: layout.card.height)
                    .scaleEffect(shown ? 1 : (reduceMotion ? 1 : 0.85), anchor: cardAnchor(layout))
                    .opacity(shown ? 1 : 0)
                    .animation(appear(delay: 0.04), value: shown)
                    .offset(x: layout.card.minX - origin.x, y: layout.card.minY - origin.y)
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .ignoresSafeArea()
        .allowsHitTesting(!closing)
        .sensoryFeedback(.selection, trigger: picks)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { close() }
        .onAppear {
            withAnimation(motion) { shown = true }
        }
    }

    // MARK: - Pieces

    private var backdrop: some View {
        Rectangle()
            .fill(.ultraThinMaterial)
            .overlay(Color.black.opacity(0.16))
            .opacity(shown ? 1 : 0)
            .contentShape(Rectangle())
            .onTapGesture { close() }
            .accessibilityLabel(Text("Close"))
            .accessibilityAddTraits(.isButton)
    }

    /// The lifted copy: from the bubble's frame to the layout's (instantly under Reduce Motion),
    /// and back to wherever the bubble is when it closes.
    private func copy(layout: BubbleMenuLayout) -> some View {
        let rest = home ?? request.origin
        let rect = shown || reduceMotion ? layout.bubble : rest
        let clip = shown && layout.clipped
        return BubbleMenuCopy(message: message, tail: request.tail)
            .frame(width: request.origin.width)
            .fixedSize(horizontal: false, vertical: true)
            .frame(width: rect.width, height: clip ? rect.height : nil, alignment: .top)
            .clipped()
            .mask {
                LinearGradient(
                    stops: clip
                        ? [.init(color: .black, location: 0), .init(color: .black, location: max(1 - 44 / max(rect.height, 1), 0)), .init(color: .clear, location: 1)]
                        : [.init(color: .black, location: 0), .init(color: .black, location: 1)],
                    startPoint: .top, endPoint: .bottom
                )
            }
            .compositingGroup()
            .shadow(color: .black.opacity(shown ? 0.16 : 0), radius: 18, y: 8)
            .scaleEffect(shown && !reduceMotion ? 1.03 : 1)
            .opacity(reduceMotion ? (shown ? 1 : 0) : 1)
            .offset(x: rect.minX, y: rect.minY)
    }

    private var barAnchor: UnitPoint {
        request.isAssistant ? .bottomLeading : .bottomTrailing
    }

    private func cardAnchor(_ layout: BubbleMenuLayout) -> UnitPoint {
        switch (layout.cardBelow, request.isAssistant) {
        case (true, true): .topLeading
        case (true, false): .topTrailing
        case (false, true): .bottomLeading
        case (false, false): .bottomTrailing
        }
    }

    private var motion: Animation {
        reduceMotion ? .easeInOut(duration: 0.22) : .spring(response: 0.34, dampingFraction: 0.86)
    }

    /// Out of the bubble a beat apart; back in together.
    private func appear(delay: Double) -> Animation {
        shown && !reduceMotion ? motion.delay(delay) : motion
    }

    // MARK: - Rows (as in the reference: Reply, Copy, Select, Share; the assistant adds the ratings)

    private var rows: [BubbleMenuCard.Row] {
        var rows: [BubbleMenuCard.Row] = []
        if let reply = request.reply {
            rows.append(.init(glyph: .quote, title: Text("Reply")) { finish(reply) })
        }
        rows.append(.init(glyph: .copy, title: Text("Copy")) {
            UIPasteboard.general.string = message.menuText
            AccessibilityNotification.Announcement(String(localized: "Copied")).post()
            close()
        })
        rows.append(.init(glyph: .pointer, title: Text("Select text")) { open(.selectText) })
        rows.append(.init(glyph: .share, title: Text("Share")) { open(.share) })
        if request.isAssistant {
            let rating = extras.ratings[message.id]
            rows.append(.init(glyph: .done, title: Text("Good response"), checked: rating == .good) { rate(.good, current: rating) })
            rows.append(.init(glyph: .failed, title: Text("Bad response"), checked: rating == .bad) { rate(.bad, current: rating) })
        }
        return rows
    }

    /// The ratings sit under a divider.
    private var dividerIndex: Int? { request.isAssistant ? rows.count - 2 : nil }
    private var dividers: Int { dividerIndex == nil ? 0 : 1 }

    // MARK: - Actions

    private func pick(_ emoji: String) {
        picks += 1
        request.react(emoji, !message.myReactions.contains(emoji))
        close()
    }

    private func more() {
        open(.picker)
    }

    private func rate(_ rating: FeedbackRequest.Rating, current: FeedbackRequest.Rating?) {
        if current != rating { request.rate(rating) }
        close()
    }

    private func open(_ kind: BubbleMenuSheet.Kind) {
        let react = request.react
        center.sheet = BubbleMenuSheet(kind: kind, text: message.menuText, selected: message.myReactions, react: react)
        close()
    }

    private func finish(_ action: @escaping () -> Void) {
        close()
        action()
    }

    private func close() {
        guard !closing else { return }
        let id = request.id
        home = center.currentFrame == .zero ? request.origin : center.currentFrame
        closing = true
        withAnimation(motion, completionCriteria: .logicallyComplete) {
            shown = false
        } completion: {
            center.finish(id)
        }
        // In case the animation's completion never reports (the view went away mid-way).
        Task {
            try? await Task.sleep(for: .milliseconds(700))
            center.finish(id)
        }
    }
}

// MARK: - Emoji bar

/// A glass capsule with a horizontally scrolling row of emoji and a "+" circle pinned at its
/// trailing end that opens the full picker. The user's own reactions show highlighted (and any
/// they picked from the full list come first).
struct BubbleEmojiBar: View {
    static let quick = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉", "👏", "💯", "✅", "👀"]

    var selected: Set<String>
    var onPick: (String) -> Void
    var onMore: () -> Void

    private var emojis: [String] {
        selected.subtracting(Self.quick).sorted() + Self.quick
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(emojis, id: \.self) { emoji in
                        Button { onPick(emoji) } label: {
                            Text(verbatim: emoji)
                                .font(.system(size: 28))
                                .frame(width: 44, height: 44)
                                .background(Circle().fill(selected.contains(emoji) ? Palette.primaryText.opacity(0.1) : .clear))
                                .contentShape(Circle())
                        }
                        .buttonStyle(PressableButtonStyle(scale: 0.82))
                        .accessibilityLabel(Self.label(emoji))
                        .accessibilityAddTraits(selected.contains(emoji) ? .isSelected : [])
                    }
                }
                .padding(.leading, 8)
                // Room for the + circle over the row's end.
                .padding(.trailing, 56)
            }
            Button(action: onMore) {
                DuetIcon(glyph: .add, size: 20, tint: Palette.secondaryText)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Palette.floatingSurface))
                    .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: Metrics.hairline))
                    .contentShape(Circle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.88))
            .padding(.trailing, 6)
            .accessibilityLabel(Text("Add a reaction"))
        }
        .frame(maxHeight: .infinity)
        .menuSurface(Capsule())
    }

    static func label(_ emoji: String) -> Text {
        switch emoji {
        case "👍": Text("React with thumbs up")
        case "❤️": Text("React with heart")
        case "⭐": Text("React with star")
        default: Text(verbatim: emoji)
        }
    }
}

// MARK: - Menu card

/// The white (glass on iOS 26) rounded card with icon + label rows, as in the reference.
struct BubbleMenuCard: View {
    struct Row: Identifiable {
        let id = UUID()
        var glyph: DuetGlyph
        var title: Text
        var checked = false
        var action: () -> Void
    }

    var rows: [Row]
    var dividerBefore: Int?
    var rowHeight: CGFloat

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17

    static let padding: CGFloat = 8

    static func height(rows: Int, dividers: Int, rowHeight: CGFloat) -> CGFloat {
        CGFloat(rows) * rowHeight + CGFloat(dividers) * 9 + padding * 2
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index == dividerBefore {
                    Rectangle().fill(Palette.hairline).frame(height: Metrics.hairline)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 4)
                        .frame(height: 9)
                }
                Button(action: row.action) {
                    HStack(spacing: 14) {
                        DuetIcon(glyph: row.glyph, size: 22, tint: Palette.primaryText)
                        row.title
                            .font(.system(size: fontSize))
                            .foregroundStyle(Palette.primaryText)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                        Spacer(minLength: 8)
                        if row.checked {
                            DuetIcon(glyph: .check, size: 16, tint: Palette.secondaryText)
                        }
                    }
                    .padding(.horizontal, 16)
                    .frame(height: rowHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(MenuRowStyle())
                .accessibilityAddTraits(row.checked ? .isSelected : [])
            }
        }
        .padding(.vertical, Self.padding)
        .menuSurface(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

/// A row lights a soft grey under the finger.
private struct MenuRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Palette.primaryText.opacity(configuration.isPressed ? 0.07 : 0))
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private extension View {
    /// The bar's and the card's surface: glass on iOS 26, the white (#333333) floating fill with a
    /// hairline and a soft shadow on iOS 18.
    @ViewBuilder
    func menuSurface<S: InsettableShape>(_ shape: S) -> some View {
        if #available(iOS 26, *) {
            self.glassEffect(.regular.tint(Palette.menuSurfaceTint), in: shape)
                .shadow(color: .black.opacity(0.08), radius: 16, y: 6)
        } else {
            self.background {
                shape.fill(Palette.floatingSurface)
                    .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                    .shadow(color: .black.opacity(0.12), radius: 18, y: 6)
            }
        }
    }
}

extension Palette {
    /// The menu's glass: whiter than the chrome's, so its rows read over the dimmed screen.
    static let menuSurfaceTint = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: 0x2A2A2A, alpha: 0.6)
            : UIColor(hex: 0xFFFFFF, alpha: 0.72)
    })
}
