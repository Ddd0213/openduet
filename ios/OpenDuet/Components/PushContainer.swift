// A page hierarchy inside a sheet or the side menu (profile > Apps and connectors > Add
// connector, the assistant > Activity, menu > Archived). M19: each page names its parent (`parent`,
// nil = the root; the default keeps every page one level deep). Going deeper slides the new page
// in from the trailing edge over the old one, which stays drawn under it a quarter to the left;
// going back up (to an ancestor or the root) slides the old page out to the trailing edge and
// reveals the target underneath (PushStackRules decides which). The back swipe from the left edge
// drags the page and reveals its parent, then goes there (L186). Only the page and the one under
// it are drawn; the root stays mounted but hidden, so its scroll position survives. With Reduce
// Motion pages crossfade. Hand-built like the task detail so the pages keep the app's own header
// instead of a navigation bar. The drag lives in `PageDrag`, read only by the layers' motion
// modifier, so a drag frame doesn't re-run `root()` or `destination()`.
import SwiftUI

struct PushContainer<Page: Hashable, Root: View, Destination: View>: View {
    @Binding var page: Page?
    var parent: (Page) -> Page?
    @ViewBuilder var root: () -> Root
    @ViewBuilder var destination: (Page) -> Destination

    /// A drawn layer: the root or one page.
    enum Layer: Hashable {
        case root
        case page(Page)
    }

    private struct Slot: Identifiable {
        var layer: Layer
        var role: PushLayerRole
        var id: Layer { layer }
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The page on screen; follows `page` with the slide.
    @State private var shown: Page?
    /// `shown`'s parent as it was when it came up (Back after a delete still counts as a pop).
    @State private var shownParent: Page?
    /// A replace: the page the new one slides in over stays drawn until the slide ends.
    @State private var held: Layer?
    /// A pop: the old page sliding out to the trailing edge.
    @State private var leaving: Page?
    /// The page on top came up from underneath (a pop) rather than in from the trailing edge.
    @State private var revealing = false
    /// Bumped by every move, so a finished slide only clears what is still its own.
    @State private var moveToken = 0
    /// Pushes, for the selection haptic.
    @State private var pushes = 0
    @State private var drag = PageDrag()
    @State private var width: CGFloat = 390
    /// A PushContainer inside the page on top shows a page of its own: its back swipe goes first.
    @State private var innerActive = false

    init(
        page: Binding<Page?>,
        parent: @escaping (Page) -> Page? = { _ in nil },
        @ViewBuilder root: @escaping () -> Root,
        @ViewBuilder destination: @escaping (Page) -> Destination
    ) {
        _page = page
        self.parent = parent
        self.root = root
        self.destination = destination
        let initial = page.wrappedValue
        _shown = State(initialValue: initial)
        _shownParent = State(initialValue: initial.flatMap(parent))
    }

    var body: some View {
        ZStack {
            ForEach(slots) { slot in
                layerView(slot.layer)
                    .transformPreference(PushActiveKey.self) { if slot.role != .top { $0 = false } }
                    .modifier(PushLayerMotion(drag: drag, role: slot.role, width: width, reduceMotion: reduceMotion))
                    .zIndex(layerOrder(slot.role))
                    .transition(layerTransition(slot.role))
            }
        }
        .clipped()
        .simultaneousGesture(backSwipe, including: shown != nil && !innerActive ? .all : .subviews)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = max($0, 1) }
        .onPreferenceChange(PushActiveKey.self) { innerActive = $0 }
        .preference(key: PushActiveKey.self, value: shown != nil || innerActive)
        .onChange(of: page) { _, new in follow(new) }
        .sensoryFeedback(.selection, trigger: pushes)
    }

    // MARK: - Layers

    /// The page on top, what is under it (its parent, or the page a replace slides over), the
    /// page sliding out of a pop, and the root (kept mounted, hidden, when it is neither).
    private var slots: [Slot] {
        var list: [Slot] = []
        func add(_ layer: Layer, _ role: PushLayerRole) {
            if !list.contains(where: { $0.layer == layer }) { list.append(Slot(layer: layer, role: role)) }
        }
        add(shown.map(Layer.page) ?? .root, .top)
        if let leaving { add(.page(leaving), .leaving) }
        if let held { add(held, .held) }
        if shown != nil { add(shownParent.map(Layer.page) ?? .root, .under) }
        add(.root, .parked)
        return list
    }

    @ViewBuilder private func layerView(_ layer: Layer) -> some View {
        switch layer {
        case .root:
            root()
        case .page(let page):
            destination(page)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background(Palette.sheetBackground)
                .background(alignment: .leading) { PushEdgeShadow() }
        }
    }

    private func layerOrder(_ role: PushLayerRole) -> Double {
        switch role {
        case .parked: 0
        case .under: 1
        case .held: 1.5
        case .top: 2
        case .leaving: 3
        }
    }

    /// A page added on top slides in from the trailing edge, or comes up from a quarter to the
    /// left when it is revealed by a pop; with Reduce Motion it fades. Every other layer comes and
    /// goes covered, so it does without.
    private func layerTransition(_ role: PushLayerRole) -> AnyTransition {
        guard role == .top else { return .identity }
        if reduceMotion { return .opacity }
        if revealing { return .offset(x: -width * 0.25) }
        return .move(edge: .trailing)
    }

    // MARK: - Moves

    private var slide: Animation {
        reduceMotion ? .easeInOut(duration: 0.22) : .spring(response: 0.4, dampingFraction: 0.9)
    }

    /// `page` changed (a row, a Back button, a finished add): push, pop or replace to it.
    private func follow(_ new: Page?) {
        let old = shown
        let ancestors = shownParent.map { [$0] + PushStackRules.ancestors(of: $0, parent: parent) } ?? []
        let move = PushStackRules.move(from: old, to: new, oldAncestors: ancestors, newParent: new.flatMap(parent))
        guard move != .none else { return }
        moveToken += 1
        let token = moveToken
        drag.x = 0
        if move == .push { pushes += 1 }
        withAnimation(slide) {
            shown = new
            shownParent = new.flatMap(parent)
            revealing = move == .pop
            switch move {
            case .pop:
                held = nil
                leaving = old
            case .replace:
                held = old.map(Layer.page) ?? .root
                if leaving == new { leaving = nil }
            case .push, .none:
                if leaving == new { leaving = nil }
            }
        } completion: {
            guard token == moveToken else { return }
            held = nil
            leaving = nil
        }
    }

    // MARK: - Back swipe

    /// From the left edge only, so lists and pickers inside the page keep their own drags.
    private var backSwipe: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard !reduceMotion, value.startLocation.x < 28, value.translation.width > 0,
                      abs(value.translation.width) > abs(value.translation.height) else { return }
                settleForSwipe()
                drag.x = value.translation.width
            }
            .onEnded { value in
                guard value.startLocation.x < 28, shown != nil else { return }
                let commits = PushStackRules.swipeCommits(
                    translation: value.translation.width, projected: value.predictedEndTranslation.width, length: width
                )
                if commits {
                    goBack()
                } else {
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) { drag.x = 0 }
                }
            }
    }

    /// A swipe starting while a slide still ends: what it was holding goes, so the page revealed
    /// under the finger is the parent.
    private func settleForSwipe() {
        guard held != nil || leaving != nil else { return }
        moveToken += 1
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            held = nil
            leaving = nil
            revealing = false
        }
    }

    /// The swipe let go past the threshold: the page finishes sliding out, then its parent is the
    /// page (without a second animation: it is already in place).
    private func goBack() {
        let target = shownParent
        guard !reduceMotion else {
            page = target
            return
        }
        moveToken += 1
        let token = moveToken
        withAnimation(.easeOut(duration: 0.18)) { drag.x = width } completion: {
            guard token == moveToken else { return }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                shown = target
                shownParent = target.flatMap(parent)
                held = nil
                leaving = nil
                revealing = false
                drag.x = 0
                page = target
            }
        }
    }
}

/// What a drawn layer of a PushContainer is doing.
enum PushLayerRole: Hashable {
    /// the page on screen
    case top
    /// its parent (or the root), a quarter to the left; the back swipe reveals it
    case under
    /// a replace: the page the new one slides in over, until it is covered
    case held
    /// a pop: the old page sliding out to the trailing edge
    case leaving
    /// the root while it is neither on top nor under: mounted (its state survives), not drawn
    case parked
}

/// The back swipe's offset: an observable box, so only the layers' motion modifier reads it.
@MainActor @Observable
final class PageDrag {
    var x: CGFloat = 0
}

/// Positions a PushContainer layer from its role and the back swipe.
struct PushLayerMotion: ViewModifier {
    var drag: PageDrag
    var role: PushLayerRole
    var width: CGFloat
    var reduceMotion: Bool

    func body(content: Content) -> some View {
        content
            .offset(x: offset)
            .opacity(opacity)
            .allowsHitTesting(role == .top)
            .accessibilityHidden(role != .top)
    }

    private var offset: CGFloat {
        guard !reduceMotion else { return 0 }
        switch role {
        case .top: return drag.x
        case .under, .held, .parked: return -width * 0.25 + drag.x * 0.25
        case .leaving: return width
        }
    }

    private var opacity: Double {
        switch role {
        case .top: 1
        case .under, .held: reduceMotion ? 0 : 1
        case .leaving, .parked: 0
        }
    }
}

/// True while a PushContainer (or one inside it) shows a page: an outer container's back swipe
/// leaves the gesture to the inner one.
struct PushActiveKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

/// A soft strip just outside a sliding page's leading edge: the shadow it casts on the page
/// under it. Cheaper than a `.shadow` on the whole page (no offscreen pass every frame); at rest
/// it lies past the container's (or the screen's) edge.
struct PushEdgeShadow: View {
    var body: some View {
        LinearGradient(colors: [.black.opacity(0), .black.opacity(0.08)], startPoint: .leading, endPoint: .trailing)
            .frame(width: 14)
            .offset(x: -14)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
