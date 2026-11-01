// The viewer's smaller pieces (prompt L151, L181): the dashboard's status line under its title
// ("Loading 2 sources" ◌ → "Refreshing..." → "Updated now"; Refresh and Data sources are in ⋯),
// the ✎ / Comment bar, the Contents and Sources sheets, and the share sheet (Share, Export PDF).
import SwiftUI
import UIKit

/// "Loading 2 sources" ◌ → "Refreshing..." → "Updated now" (or the refresh's failure).
struct DashboardStatus: View {
    var artifact: ArtifactSummary?
    var sourceCount: Int
    var loading: Bool
    var refreshing: Bool
    var refreshFailure: String?
    /// The spinner's colour (the small line's, which follows the page colour in the viewer).
    var ink: Color = Palette.secondaryText

    @Environment(\.locale) private var locale

    var body: some View {
        status
            .animation(.easeInOut(duration: 0.3), value: loading)
            .animation(.easeInOut(duration: 0.3), value: refreshing)
    }

    @ViewBuilder
    private var status: some View {
        if loading {
            HStack(spacing: 6) {
                Text("Loading \(sourceCount) sources")
                SpinnerArc(size: 12, color: ink, lineWidth: 1.6)
            }
            .transition(.opacity)
        } else if refreshing {
            HStack(spacing: 6) {
                Text("Refreshing...")
                SpinnerArc(size: 12, color: ink, lineWidth: 1.6)
            }
            .transition(.opacity)
        } else if let refreshFailure {
            Text(verbatim: refreshFailure).transition(.opacity)
        } else if let artifact {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(verbatim: MakeCopy(format: ChatDateFormat(locale: locale)).updated(artifact.updatedAt, now: context.date))
            }
            .transition(.opacity)
        }
    }
}

/// ✎ "What should OpenDuet change?" or Comment (with the selected passage quoted above).
struct ArtifactEditBar: View {
    enum Mode: Hashable { case edit, comment(quote: String?) }

    var mode: Mode
    var request: CardRequest?
    var onSend: (String) -> Void
    var onClose: () -> Void
    /// The failure note sits straight on the bar's background (the page colour in the viewer).
    var noteInk: Color = Palette.secondaryText

    @State private var text = ""
    @State private var sends = 0
    @FocusState private var focused: Bool
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var noteSize: CGFloat = 14

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var busy: Bool { request == .inFlight }
    private var quote: String? { if case .comment(let quote) = mode { quote } else { nil } }
    private var canSend: Bool { !busy && (!trimmed.isEmpty || quote != nil) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let reason = request?.failureReason {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    DuetIcon(glyph: .warning, size: noteSize + 2, tint: Palette.failure)
                    Text(verbatim: reason).foregroundStyle(noteInk)
                }
                .font(.system(size: noteSize))
                .padding(.horizontal, 8)
                .transition(.opacity)
            }
            VStack(alignment: .leading, spacing: 8) {
                if let quote {
                    HStack(alignment: .top, spacing: 8) {
                        Capsule().fill(Palette.justMade).frame(width: 3)
                        Text(verbatim: quote)
                            .font(.system(size: noteSize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(3)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 6)
                    .padding(.top, 4)
                }
                HStack(alignment: .bottom, spacing: 6) {
                    Button(action: onClose) {
                        Image(glyph: .close)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Palette.secondaryText)
                            .frame(width: 36, height: 36)
                            .contentShape(Circle())
                    }
                    .buttonStyle(PressableButtonStyle(scale: 0.9))
                    .accessibilityLabel(Text("Cancel"))
                    TextField(text: $text, axis: .vertical) {
                        quote == nil && mode == .edit ? Text("What should OpenDuet change?") : Text("Add a comment")
                    }
                    .font(.system(size: fontSize))
                    .lineLimit(1...5)
                    .focused($focused)
                    .frame(minHeight: 36)
                    Button(action: send) {
                        ZStack {
                            Circle().fill(canSend || busy ? Palette.fab : Palette.composerAction).opacity(canSend || busy ? 1 : 0.25)
                            if busy {
                                ProgressView().tint(.white).controlSize(.small)
                            } else {
                                Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold)).foregroundStyle(canSend ? Color.white : Palette.background)
                                    .accessibilityHidden(true)
                            }
                        }
                        .frame(width: 36, height: 36)
                    }
                    .buttonStyle(PressableButtonStyle(scale: 0.9))
                    .disabled(!canSend)
                    .accessibilityLabel(Text("Send"))
                }
            }
            .padding(6)
            .chromeSurface(RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        .animation(.easeInOut(duration: 0.25), value: request)
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .onAppear { focused = true }
        .onChange(of: mode) { _, _ in focused = true }
    }

    private func send() {
        guard canSend else { return }
        focused = false
        sends += 1
        onSend(trimmed)
    }
}

/// Contents (L181): the doc's h1-h3; a tap scrolls the reader there.
struct ContentsSheet: View {
    var headings: [DocOutline.Heading]
    var onPick: (DocOutline.Heading) -> Void
    var onClose: () -> Void

    @ScaledMetric(relativeTo: .body) private var topSize: CGFloat = 17
    @ScaledMetric(relativeTo: .callout) private var subSize: CGFloat = 16

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Contents"), leading: .close, onLeading: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(headings) { heading in
                        Button { onPick(heading) } label: {
                            Text(verbatim: heading.text)
                                .font(.system(size: heading.level == 1 ? topSize : subSize, weight: heading.level == 1 ? .semibold : .regular))
                                .foregroundStyle(heading.level == 3 ? Palette.secondaryText : Palette.primaryText)
                                .multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .padding(.leading, CGFloat(heading.level - 1) * 16)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(RowPressStyle())
                        if heading.id != headings.last?.id { Divider().padding(.leading, CGFloat(heading.level - 1) * 16) }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 6)
                .cardSurface()
                .padding(16)
            }
        }
    }
}

/// The dashboard's database icon: where its numbers come from (`detail.sources`).
struct SourcesSheet: View {
    var sources: [ArtifactSource]
    var schedule: String?
    var onClose: () -> Void

    @ScaledMetric(relativeTo: .body) private var nameSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 14

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Sources"), leading: .close, onLeading: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(spacing: 0) {
                        ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                            HStack(alignment: .top, spacing: 12) {
                                ConnectorLogo(toolkit: CardFormat.toolkitSlug(source.app) ?? "", name: source.app ?? source.name, size: 30)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(verbatim: source.name).font(.system(size: nameSize, weight: .semibold)).foregroundStyle(Palette.primaryText)
                                    if !source.detail.isEmpty {
                                        Text(verbatim: source.detail).font(.system(size: detailSize)).foregroundStyle(Palette.secondaryText)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 12)
                            .accessibilityElement(children: .combine)
                            if index < sources.count - 1 { Divider() }
                        }
                    }
                    .padding(.horizontal, 16)
                    .cardSurface()
                    if let schedule {
                        Label { Text(verbatim: schedule) } icon: { DuetIcon(glyph: .clock, size: detailSize + 4, tint: Palette.secondaryText) }
                            .font(.system(size: detailSize))
                            .foregroundStyle(Palette.secondaryText)
                            .padding(.horizontal, 6)
                    }
                }
                .padding(16)
            }
        }
    }
}

/// The system share sheet for a file the viewer wrote (Share, Export PDF: Save to Files is in it).
struct ShareFile: Identifiable {
    var url: URL
    var id: URL { url }

    /// A temporary file named after the artifact.
    static func write(_ data: Data, title: String, ext: String) -> ShareFile? {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Make", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safe = title.components(separatedBy: CharacterSet(charactersIn: "/\\:?%*|\"<>")).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let url = folder.appendingPathComponent((safe.isEmpty ? "Artifact" : String(safe.prefix(80))) + "." + ext)
        do {
            try data.write(to: url, options: .atomic)
            return ShareFile(url: url)
        } catch {
            return nil
        }
    }
}

struct ActivitySheet: UIViewControllerRepresentable {
    var items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
