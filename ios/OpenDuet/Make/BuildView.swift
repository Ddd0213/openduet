// The Build view (prompt L150, L164): it replaces the shell's header with one animating mascot
// (no ≡, no initials) and ✕ on the right; under it the title (semibold, truncated), the status
// ("Starting up" → "Waking OpenDuet's workspace" → the real build steps, crossfading) with the
// elapsed timer on the right, and a large rounded skeleton card shaped like the type whose
// border an orange line runs around. The shell swaps the composer for WorkingPill and keeps
// the tab bar; leaving lets the build go on. A failed build shows its reason with Retry.
import SwiftUI

/// The header while the Build view shows: the mascot top-centre, ✕ right. M29: `event` is the
/// mascot's `done` when the build is ready (the shell holds the view a moment for it).
struct BuildHeader: View {
    var event: MascotEvent? = nil
    var onClose: () -> Void

    var body: some View {
        // The shell pins it with `duetBar(.top)` (the progressive mask, on iOS 18 and iOS 26 alike).
        ChromeGlassGroup {
            HStack(alignment: .top) {
                Color.clear.frame(width: Metrics.headerCircle, height: Metrics.headerCircle)
                Spacer(minLength: 12)
                DuetMascot(pose: .working, size: 34, animated: true, event: event)
                    .floatingCircle(Metrics.headerMascot, interactive: false)
                    .accessibilityLabel(Text(verbatim: "OpenDuet"))
                    .accessibilityValue(Text("Making it"))
                Spacer(minLength: 12)
                CircleIconButton(systemImage: DuetGlyph.close.symbol, label: Text("Close"), action: onClose)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 16)
    }
}

struct BuildView: View {
    var artifact: ArtifactSummary?
    var artifactId: String
    var status: Phrase?
    var request: CardRequest?
    var onRetry: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .title2) private var titleSize: CGFloat = 22
    @ScaledMetric(relativeTo: .subheadline) private var statusSize: CGFloat = 15

    private var failed: Bool { artifact?.status == .failed }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                titleBlock
                card
                if failed { failure.transition(.opacity) }
            }
            .padding(.horizontal, Metrics.threadInset + 4)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86), value: failed)
        .sensoryFeedback(.warning, trigger: failed) { _, now in now }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if let title = artifact?.title, !title.isEmpty { Text(verbatim: title) } else { Text("Making it") }
            }
            .font(.system(size: titleSize, weight: .semibold))
            .foregroundStyle(Palette.primaryText)
            .lineLimit(1)
            .truncationMode(.tail)
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                statusLine
                    .font(.system(size: statusSize))
                    .foregroundStyle(Palette.secondaryText)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                timer
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var statusLine: some View {
        ZStack(alignment: .leading) {
            if failed {
                Text("Couldn't finish this one").transition(.opacity)
            } else if let status {
                PhraseText(phrase: status).id(status).transition(.opacity)
            } else {
                Text("Starting up").transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.35), value: status)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var timer: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let start = artifact?.createdAt ?? context.date
            let end = failed ? (artifact?.updatedAt ?? context.date) : context.date
            Text(verbatim: MakeCopy.elapsed(end.timeIntervalSince(start)))
                .font(.system(size: statusSize).monospacedDigit())
                .foregroundStyle(Palette.secondaryText)
                .contentTransition(.numericText())
        }
        .accessibilityHidden(true)
    }

    private var card: some View {
        let type = artifact?.type ?? .webPage
        return ZStack {
            RoundedRectangle(cornerRadius: Metrics.buildCorner, style: .continuous)
                .fill(Palette.cardSurface)
                .strokeBorder(Palette.cardBorder, lineWidth: Metrics.hairline)
            BuildSkeleton(type: type)
                .padding(18)
                .opacity(failed ? 0.45 : 1)
            if !failed {
                ProgressPerimeter(corner: Metrics.buildCorner)
                    .transition(.opacity)
            }
        }
        .aspectRatio(0.78, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .accessibilityElement()
        .accessibilityLabel(failed ? Text("Couldn't finish this one") : Text("OpenDuet is working on it..."))
    }

    private var failure: some View {
        VStack(alignment: .leading, spacing: 8) {
            if case .failed(let reason)? = request {
                InlineFailure(reason: reason, onRetry: onRetry, onEdit: nil)
            } else {
                InlineFailure(reason: failureReason, onRetry: onRetry, onEdit: nil)
                    .disabled(request == .inFlight)
            }
        }
    }

    private var failureReason: String {
        if let status {
            let text = PhraseText.string(status)
            if !text.isEmpty { return text }
        }
        return String(localized: "Something went wrong.")
    }
}
