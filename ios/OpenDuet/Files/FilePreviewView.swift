// The full-screen file preview (PART C, L179, L180): ✕ and the file's name on top, Share once
// the copy is ready. While the copy downloads, the type tile and name over a pulse; when it
// fails, the reason and Retry. Hosted by whichever surface is frontmost (the shell, the profile
// sheet, the channel sheet) so it always covers what the user tapped.
// M9: the header sits on the app's progressive mask (Theme/ChromeBars.swift); Quick Look keeps its
// own scroll view below the header (it can't take our insets).
// M26: an HTML file sits below the header too, the way the Make viewer's page does
// (FilePreviewLayout): its top, fixed / sticky headers and 100vh layouts included, starts at the
// header's lower edge. Only its bottom reaches under the soft edge over the home indicator and
// scrolls under it, resting clear of it with a bottom inset.
// M26: the header's right circle is a ⋯ menu: Share (once the copy is ready) and Delete. Delete
// asks in place at the bottom of the preview (FileDeleteConfirm, with the "Also delete from
// OpenDuet's computer" switch), never in an alert; a success closes the preview, a refusal stays.
import SwiftUI

struct FilePreviewView: View {
    var preview: FilePreviewState
    var actions: FileActions

    @ScaledMetric(relativeTo: .headline) private var titleSize: CGFloat = 16
    /// The page's frame inside the chrome and the web view's (it reaches past the page's bottom,
    /// under the soft edge over the home indicator), both global.
    @State private var pageBox: CGRect = .zero
    @State private var webBox: CGRect = .zero
    /// M26: the ⋯ menu's Delete asked (the question at the bottom) and its switch
    @State private var confirmingDelete = false
    @State private var alsoWorkspace = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isWeb: Bool {
        if case .ready = preview.phase { return preview.kind.usesWebView }
        return false
    }

    private var deleting: Bool { preview.deleting == .inFlight }
    private var asksDelete: Bool { confirmingDelete || deleting }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { pageBox = $0 }
            .duetBar(.top, spacing: 10) { header }
            .duetBar(.bottom, fade: 16, masked: isWeb) { bottomBar }
            .background(Palette.background.ignoresSafeArea())
            .animation(.easeInOut(duration: 0.25), value: preview.phase)
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86), value: asksDelete)
            .animation(.easeInOut(duration: 0.2), value: preview.deleting)
            // Another file in the same cover: its own question, if any.
            .onChange(of: preview.id) { _, _ in
                confirmingDelete = false
                alsoWorkspace = false
            }
    }

    /// The delete question in place at the bottom (nothing there otherwise).
    @ViewBuilder private var bottomBar: some View {
        if asksDelete {
            FileDeleteConfirm(
                file: preview.file, alsoWorkspace: $alsoWorkspace, busy: deleting, failure: preview.deleting?.failure,
                onConfirm: actions.deletePreviewed,
                onCancel: { confirmingDelete = false }
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
        } else {
            Color.clear.frame(height: 0)
        }
    }

    /// ⋯: Share once the copy is ready, Delete whenever the file is known by its id.
    private var moreMenu: some View {
        Menu {
            if case .ready(let url) = preview.phase {
                ShareLink(item: url) {
                    Label { Text("Share") } icon: { Image(systemName: DuetGlyph.share.symbol) }
                }
            }
            Button(role: .destructive) {
                alsoWorkspace = false
                confirmingDelete = true
            } label: {
                Label { Text("Delete") } icon: { Image(systemName: DuetGlyph.delete.symbol) }
            }
            .disabled(deleting)
        } label: {
            Image(systemName: DuetGlyph.more.symbol)
                .glyphFont(17)
                .foregroundStyle(Palette.primaryText)
                .floatingCircle(Metrics.headerCircle)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.92))
        .accessibilityLabel(Text("More"))
    }

    private var header: some View {
        HStack(spacing: 12) {
            FileChromeButton(systemImage: "xmark", label: Text("Close"), action: actions.closePreview)
            Text(verbatim: preview.file.name)
                .font(.system(size: titleSize, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            // M26: Share moved into ⋯ next to Delete; the circle is there in every phase, so the
            // name stays centred.
            moreMenu
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }

    @ViewBuilder private var content: some View {
        switch preview.phase {
        case .loading:
            VStack(spacing: 14) {
                FileGlyphTile(kind: preview.kind, size: 64)
                    .skeletonPulse()
                Text(verbatim: preview.file.name)
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.secondaryText)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 32)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Loading \(preview.file.name)"))
        case .failed(let reason):
            InlineRetryLine(reason: reason, onRetry: actions.retryPreview)
                .padding(.horizontal, 32)
        case .ready(let url):
            if preview.kind.usesWebView {
                // It starts at the header's lower edge (never under it, so nothing waits for a
                // top inset) and reaches the screen bottom, its bottom inset keeping the last
                // line clear of the soft edge and the home indicator.
                HTMLFileView(url: url, bottomInset: FilePreviewLayout.bottomInset(page: pageBox, web: webBox))
                    .ignoresSafeArea(.container, edges: .bottom)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { webBox = $0 }
            } else {
                QuickLookPreview(url: url)
                    .id(url)
                    .ignoresSafeArea(edges: .bottom)
            }
        }
    }
}

extension View {
    /// Presents the file preview full screen from this surface while `active` (only the
    /// frontmost surface hosts it). ✕ closes it through the store.
    func filePreviewHost(preview: FilePreviewState?, active: Bool, actions: FileActions) -> some View {
        modifier(FilePreviewHost(preview: preview, active: active, actions: actions))
    }
}

private struct FilePreviewHost: ViewModifier {
    var preview: FilePreviewState?
    var active: Bool
    var actions: FileActions

    /// The last preview shown, so the cover keeps its content while it slides away.
    @State private var shown: FilePreviewState?

    func body(content: Content) -> some View {
        content
            .onChange(of: preview, initial: true) { _, new in
                if let new { shown = new }
            }
            .fullScreenCover(isPresented: Binding(
                get: { active && preview != nil },
                set: { presented in if !presented, preview != nil { actions.closePreview() } }
            )) {
                if let shown {
                    FilePreviewView(preview: preview ?? shown, actions: actions)
                }
            }
    }
}
