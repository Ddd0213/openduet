// The full reaction picker (M9): the emoji bar's "+" opens it as a sheet. A search field, a row of
// category tabs (tap to jump), and the emoji in a grid by category (EmojiCatalog). The user's own
// reactions show highlighted; tapping one toggles it on the bubble and closes the sheet.
import SwiftUI

struct EmojiPickerSheet: View {
    var selected: Set<String>
    var onPick: (String) -> Void
    var onClose: () -> Void

    @Environment(\.locale) private var locale
    @State private var query = ""
    @State private var picks = 0
    @FocusState private var searching: Bool
    @ScaledMetric(relativeTo: .body) private var fieldSize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var headerSize: CGFloat = 13

    private let columns = [GridItem(.adaptive(minimum: 44, maximum: 52), spacing: 4)]
    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Add a reaction"), leading: .close, onLeading: onClose)
            searchField
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            ScrollViewReader { proxy in
                if trimmed.isEmpty {
                    tabs(proxy)
                }
                ScrollView {
                    if trimmed.isEmpty {
                        LazyVStack(alignment: .leading, spacing: 12, pinnedViews: []) {
                            ForEach(EmojiCatalog.categories) { category in
                                Text(category.title)
                                    .font(.system(size: headerSize, weight: .semibold))
                                    .foregroundStyle(Palette.secondaryText)
                                    .padding(.horizontal, 4)
                                    .accessibilityAddTraits(.isHeader)
                                    .id(category.id)
                                grid(category.emojis)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.bottom, 24)
                    } else {
                        let results = EmojiCatalog.search(trimmed, locale: locale)
                        if results.isEmpty {
                            Text("No emoji found")
                                .font(.system(size: fieldSize))
                                .foregroundStyle(Palette.secondaryText)
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        } else {
                            grid(results)
                                .padding(.horizontal, 12)
                                .padding(.bottom, 24)
                        }
                    }
                }
                .scrollDismissesKeyboard(.immediately)
            }
        }
        .sensoryFeedback(.selection, trigger: picks)
        .presentationDetents([.medium, .large])
        .duetSheetChrome()
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            DuetIcon(glyph: .search, size: 18, tint: Palette.secondaryText)
            TextField(text: $query) { Text("Search emoji") }
                .font(.system(size: fieldSize))
                .focused($searching)
                .submitLabel(.search)
                .autocorrectionDisabled()
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: DuetGlyph.close.symbol)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.secondaryText)
                        .frame(width: 28, height: 28)
                        .contentShape(Circle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.88))
                .accessibilityLabel(Text("Clear"))
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 40)
        .background(Capsule().fill(Palette.tile))
    }

    private func tabs(_ proxy: ScrollViewProxy) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(EmojiCatalog.categories) { category in
                    Button {
                        withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(category.id, anchor: .top) }
                    } label: {
                        Text(verbatim: category.icon)
                            .font(.system(size: 22))
                            .frame(width: 40, height: 36)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableButtonStyle(scale: 0.88))
                    .accessibilityLabel(Text(category.title))
                }
            }
            .padding(.horizontal, 12)
        }
        .padding(.bottom, 6)
    }

    private func grid(_ emojis: [String]) -> some View {
        LazyVGrid(columns: columns, spacing: 4) {
            ForEach(emojis, id: \.self) { emoji in
                Button {
                    picks += 1
                    onPick(emoji)
                } label: {
                    Text(verbatim: emoji)
                        .font(.system(size: 30))
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(selected.contains(emoji) ? Palette.primaryText.opacity(0.1) : .clear))
                        .contentShape(Circle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.82))
                .accessibilityAddTraits(selected.contains(emoji) ? .isSelected : [])
            }
        }
    }
}

/// "Select text": the bubble's whole text in a selectable text view, all of it selected and ready
/// to copy (or narrow down with the handles).
struct SelectTextSheet: View {
    var text: String
    var onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Select text"), leading: .close, onLeading: onClose)
            SelectableTextView(text: text)
                .padding(.horizontal, 12)
        }
        .presentationDetents([.medium, .large])
        .duetSheetChrome()
    }
}

/// A read-only UITextView that selects everything once it is on screen.
private struct SelectableTextView: UIViewRepresentable {
    var text: String

    func makeUIView(context: Context) -> SelectAllTextView {
        let view = SelectAllTextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(Palette.primaryText)
        view.textContainerInset = UIEdgeInsets(top: 8, left: 4, bottom: 24, right: 4)
        view.dataDetectorTypes = []
        view.text = text
        return view
    }

    func updateUIView(_ view: SelectAllTextView, context: Context) {
        if view.text != text { view.text = text }
    }
}

final class SelectAllTextView: UITextView {
    private var selectedOnce = false

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, !selectedOnce else { return }
        selectedOnce = true
        // After the sheet has landed, so the handles and the edit menu show.
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(450))
            guard let self, self.window != nil else { return }
            _ = self.becomeFirstResponder()
            self.selectAll(nil)
        }
    }
}
