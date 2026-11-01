// One run (M8 brief §7, like the reference the user gave): the status capsule, the title, "Task ·
// 12 steps", the time and duration, the error when it failed; a hairline; then a vertical
// timeline joined by a dashed line, one row per step (status icon, bold title + 2 grey lines,
// a chevron that opens Input / Output in monospaced blocks with Copy). While the run is queued
// or running the store polls GET /api/runs/:id about every 2 s for as long as this is open.
import SwiftUI

struct RunDetailPage: View {
    var runId: String
    var leading: SheetHeaderLeading
    var onLeading: () -> Void

    @Environment(\.runs) private var runs
    @Environment(\.locale) private var locale

    private var detail: RunDetailState { runs.state.detail(runId) }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Run details"), leading: leading, onLeading: onLeading)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let summary = detail.summary {
                        RunDetailHeader(run: summary, stepCount: detail.steps?.count)
                    } else if case .failed = detail.phase {
                        EmptyView()
                    } else {
                        headerSkeleton
                    }
                    Divider().overlay(Palette.cardBorder)
                    timeline
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
        }
        .animation(.easeInOut(duration: 0.25), value: detail.steps?.map(\.id))
        .animation(.easeInOut(duration: 0.25), value: detail.summary?.status)
        .onAppear { runs.actions.openRun(runId) }
        .onDisappear { runs.actions.closeRun(runId) }
    }

    @ViewBuilder private var timeline: some View {
        if let steps = detail.steps {
            if steps.isEmpty {
                Text("Nothing here yet")
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 24)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                        RunStepRow(step: step, isLast: index == steps.count - 1)
                    }
                }
            }
        } else if case .failed(let reason) = detail.phase {
            InlineRetryLine(reason: reason) { runs.actions.retryRun(runId) }
                .cardSurface()
        } else {
            timelineSkeleton
        }
    }

    private var headerSkeleton: some View {
        VStack(alignment: .leading, spacing: 10) {
            Capsule().fill(Palette.skeleton).frame(width: 64, height: 22)
            RoundedRectangle(cornerRadius: 6).fill(Palette.skeleton).frame(height: 22).padding(.trailing, 60)
            RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(width: 160, height: 13)
        }
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading"))
    }

    private var timelineSkeleton: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(0..<4, id: \.self) { index in
                HStack(alignment: .top, spacing: 12) {
                    Circle().fill(Palette.skeleton).frame(width: 20, height: 20)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 140 : 110), height: 13)
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 220 : 180), height: 10)
                    }
                }
            }
        }
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading"))
    }
}

/// The badge, title, "Task · 12 steps", "8:44 AM · 42s" and the failure line.
private struct RunDetailHeader: View {
    var run: RunSummary
    var stepCount: Int?

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .title2) private var titleSize: CGFloat = 22
    @ScaledMetric(relativeTo: .subheadline) private var metaSize: CGFloat = 14

    var body: some View {
        let format = RunFormat(locale: locale)
        VStack(alignment: .leading, spacing: 8) {
            RunStatusBadge(status: run.status)
            Text(runTitle: run.title)
                .font(.system(size: titleSize, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 4) {
                Text(RunCopy.kind(run.kind))
                Text(verbatim: "·")
                RunFormat.steps(stepCount ?? run.stepCount)
            }
            .font(.system(size: metaSize))
            .foregroundStyle(Palette.secondaryText)
            Text(verbatim: [format.rowTime(run.createdAt), format.duration(run)].compactMap { $0 }.joined(separator: " · "))
                .font(.system(size: metaSize).monospacedDigit())
                .foregroundStyle(Palette.secondaryText)
            if run.status == .failed, let error = run.error {
                Label {
                    PhraseText(phrase: error)
                } icon: {
                    DuetIcon(glyph: .error, size: metaSize + 3, tint: Palette.failure)
                }
                .font(.system(size: metaSize))
                .foregroundStyle(Palette.failure)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// One step of the timeline. The dashed line runs from under its icon to the next row's.
private struct RunStepRow: View {
    var step: RunStep
    var isLast: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 14
    @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 20

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { if step.isExpandable { expanded.toggle() } } label: { headline }
                .buttonStyle(PressableButtonStyle(scale: 0.99))
                .disabled(!step.isExpandable)
                .accessibilityElement(children: .combine)
                .accessibilityValue(status.label)
                .accessibilityHint(step.isExpandable ? (expanded ? Text("Show less") : Text("Show more")) : Text(verbatim: ""))
            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    if let input = step.input, !input.isEmpty {
                        RunMonoBlock(title: Text("Input"), text: input)
                    }
                    if let output = step.output, !output.isEmpty {
                        RunMonoBlock(title: Text("Output"), text: output)
                    }
                }
                .padding(.leading, iconSize + 12)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.bottom, isLast ? 0 : 18)
        .background(alignment: .topLeading) {
            if !isLast {
                DashedLine()
                    .stroke(Palette.secondaryText.opacity(0.45), style: StrokeStyle(lineWidth: 1.2, lineCap: .round, dash: [3, 4]))
                    .frame(width: 1.2)
                    .padding(.top, iconSize + 4)
                    .padding(.bottom, -2)
                    .offset(x: iconSize / 2 - 0.6)
                    .accessibilityHidden(true)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.86), value: expanded)
    }

    private var status: RunStepStatusIcon { RunStepStatusIcon(status: step.status, size: iconSize) }

    private var headline: some View {
        HStack(alignment: .top, spacing: 12) {
            status
            VStack(alignment: .leading, spacing: 2) {
                Text(runTitle: step.title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                if !step.detail.isEmpty {
                    Text(verbatim: step.detail)
                        .font(.system(size: detailSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .multilineTextAlignment(.leading)
            if step.isExpandable {
                Image(systemName: "chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.secondaryText)
                    .rotationEffect(.degrees(expanded ? 180 : 0))
                    .padding(.top, 4)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
    }
}

/// The timeline's connector: one vertical line down the middle of its frame.
private struct DashedLine: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        return path
    }
}
