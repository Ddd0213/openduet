// The browser window look of onboarding page 3's card (prompt L25, L143) for the app: an #EFEFEF
// top bar with three grey dots and the "OpenDuet's own computer" pill over a white body, in the
// app's light and dark palette. Used by the live browser card and the "OpenDuet's computer"
// detail; Make can reuse it.
import SwiftUI

enum BrowserPalette {
    static let bar = Color.dynamic(light: 0xEFEFEF, dark: 0x2A2A2A)
    static let dot = Color.dynamic(light: 0xC8C8C8, dark: 0x555555)
    static let pill = Color.dynamic(light: 0xFFFFFF, dark: 0x3A3A3A)
    static let body = Color.dynamic(light: 0xFFFFFF, dark: 0x1A1A1A)
}

/// Three grey window dots and the centred "OpenDuet's own computer" pill.
struct BrowserTopBar: View {
    private static let dot: CGFloat = 7
    private static let dotGap: CGFloat = 5

    @ScaledMetric(relativeTo: .caption) private var pillText: CGFloat = 11

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: Self.dotGap) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle().fill(BrowserPalette.dot).frame(width: Self.dot, height: Self.dot)
                }
            }
            Spacer(minLength: 10)
            HStack(spacing: 5) {
                DuetIcon(glyph: .computer, size: min(pillText, 14) + 2, tint: Palette.primaryText.opacity(0.8))
                Text("OpenDuet's own computer")
                    .font(.system(size: min(pillText, 15), weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .foregroundStyle(Palette.primaryText.opacity(0.8))
            .padding(.horizontal, 10)
            .frame(minHeight: 22)
            .background(Capsule().fill(BrowserPalette.pill))
            Spacer(minLength: 10)
            // Balances the dots so the pill sits in the middle of the bar.
            Color.clear.frame(width: Self.dot * 3 + Self.dotGap * 2, height: Self.dot)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 34)
        .background(BrowserPalette.bar)
        .accessibilityHidden(true)
    }
}

/// The top bar over a white body, clipped to a rounded card with a hairline.
struct BrowserWindow<Content: View>: View {
    var corner: CGFloat = Metrics.cardCorner
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            BrowserTopBar()
            content
                .frame(maxWidth: .infinity)
                .background(BrowserPalette.body)
        }
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Palette.cardBorder, lineWidth: Metrics.hairline)
        )
    }
}

/// The small "Live" label: a red dot that breathes (still under Reduce Motion) and the word.
struct BrowserLiveTag: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false
    @ScaledMetric(relativeTo: .caption) private var textSize: CGFloat = 11

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(Palette.badge)
                .frame(width: 6, height: 6)
                .opacity(dim ? 0.35 : 1)
            Text("Live")
                .font(.system(size: textSize, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(Palette.badge.opacity(0.12)))
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
    }
}

/// A page-shaped placeholder for the live screen before its first frame (pulsing while it
/// connects, still once the session is over).
struct BrowserPageSkeleton: View {
    var pulsing = true

    var body: some View {
        let bars = VStack(alignment: .leading, spacing: 9) {
            RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: 120, height: 12)
            RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(maxWidth: 220).frame(height: 9)
            RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(maxWidth: 180).frame(height: 9)
            RoundedRectangle(cornerRadius: 8).fill(Palette.skeleton).frame(maxWidth: .infinity).frame(height: 30)
                .padding(.top, 4)
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        if pulsing {
            bars.skeletonPulse()
        } else {
            bars.opacity(0.6)
        }
    }
}
