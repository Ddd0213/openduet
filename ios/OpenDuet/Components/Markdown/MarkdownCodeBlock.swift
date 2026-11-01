// A fenced code block (prompt L183): a header bar with the language and Copy (it confirms with
// a check and a light haptic), then the monospace code, scrolling sideways. M8: its own surface
// with a hairline rim, so it reads as a block of code inside the bubble.
import SwiftUI
import UIKit

struct MarkdownCodeBlock: View {
    var language: String?
    var code: String

    @ScaledMetric(relativeTo: .body) private var codeSize: CGFloat = 14
    @ScaledMetric(relativeTo: .caption) private var headerSize: CGFloat = 12
    @State private var copied = false

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 12, style: .continuous) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(Palette.codeRim).frame(height: Metrics.hairline)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(verbatim: code)
                    .font(.system(size: codeSize, design: .monospaced))
                    .lineSpacing(codeSize * 0.22)
                    .foregroundStyle(Palette.assistantText)
                    .fixedSize(horizontal: true, vertical: true)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(shape.fill(Palette.codeSurface))
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.codeRim, lineWidth: Metrics.hairline))
        .animation(.easeInOut(duration: 0.2), value: copied)
        .sensoryFeedback(.impact(weight: .light), trigger: copied) { _, new in new }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.6))
            if !Task.isCancelled { copied = false }
        }
    }

    /// The language on the left ("Code" when the fence names none), Copy on the right.
    private var header: some View {
        HStack(spacing: 8) {
            Group {
                if let language, !language.isEmpty { Text(verbatim: language) } else { Text("Code") }
            }
            .font(.system(size: headerSize, weight: .medium, design: .monospaced))
            .foregroundStyle(Palette.secondaryText)
            .lineLimit(1)
            Spacer(minLength: 8)
            Button {
                UIPasteboard.general.string = code
                copied = true
            } label: {
                HStack(spacing: 4) {
                    Image(glyph: copied ? .check : .copy)
                        .font(.system(size: headerSize, weight: .medium))
                        .contentTransition(.symbolEffect(.replace))
                    copied ? Text("Copied") : Text("Copy")
                }
                .font(.system(size: headerSize, weight: .medium))
                .foregroundStyle(copied ? Palette.success : Palette.secondaryText)
                .contentTransition(.opacity)
                .padding(.vertical, 8)
                .padding(.leading, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel(copied ? Text("Copied") : Text("Copy code"))
        }
        .padding(.leading, 12)
        .padding(.trailing, 10)
        .frame(minHeight: 32)
        .background(Palette.codeHeader)
    }
}

extension Palette {
    /// The bar above a code block and a table's header row.
    static let codeHeader = Color.dynamic(light: 0x141413, dark: 0xFFFFFF).opacity(0.04)
    /// The rim of code blocks and tables and the lines inside them.
    static let codeRim = Color.dynamic(light: 0x141413, dark: 0xFFFFFF).opacity(0.09)
}
