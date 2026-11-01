// The viewer's bars take the page's own background (fullscreen and the 4th tab): after each load
// the page reports its `body` and `html` background colours and its `theme-color`, already
// serialised by WebKit; this turns them into one opaque colour (body, else html, else theme-color,
// else the app's background) and says whether it is dark, so the bar's buttons, title and small
// text switch to the dark look on a dark page and the light look on a light one.
// Pure Foundation (host tests).
import Foundation

/// An sRGB colour, components 0...1.
struct PageColor: Equatable, Sendable {
    var red: Double
    var green: Double
    var blue: Double
    var alpha: Double = 1

    static func rgb(_ hex: UInt32) -> PageColor {
        PageColor(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    /// The app's background (Palette.background) in light and dark.
    static let appLight = rgb(0xF4F4F4)
    static let appDark = rgb(0x0C0C0C)
    /// Palette.secondaryText and Palette.primaryText in light and dark.
    static let greyLight = rgb(0x8A8A86)
    static let greyDark = rgb(0x9A9A96)
    static let inkLight = rgb(0x141413)
    static let inkDark = rgb(0xF2F2F2)
}

/// What the page reported: computed `background-color` of body and html, and the theme-color
/// meta (the one matching the current scheme), as CSS strings; nil when missing.
struct PageBackdrop: Equatable, Sendable {
    var body: String?
    var html: String?
    var theme: String?
}

enum PageTint {
    /// The bars' colour: body's background if it shows (over html's and the app's), else html's,
    /// else theme-color, else `base`. Always opaque.
    static func resolve(_ backdrop: PageBackdrop, base: PageColor) -> PageColor {
        let body = parse(backdrop.body).flatMap(visible)
        let html = parse(backdrop.html).flatMap(visible)
        if body != nil || html != nil {
            var color = base
            if let html { color = over(html, color) }
            if let body { color = over(body, color) }
            return color
        }
        if let theme = parse(backdrop.theme).flatMap(visible) { return over(theme, base) }
        return base
    }

    /// `top` composited over `bottom` (source-over), opaque when `bottom` is.
    static func over(_ top: PageColor, _ bottom: PageColor) -> PageColor {
        let a = top.alpha + bottom.alpha * (1 - top.alpha)
        guard a > 0 else { return PageColor(red: 0, green: 0, blue: 0, alpha: 0) }
        func mix(_ t: Double, _ b: Double) -> Double { (t * top.alpha + b * bottom.alpha * (1 - top.alpha)) / a }
        return PageColor(red: mix(top.red, bottom.red), green: mix(top.green, bottom.green), blue: mix(top.blue, bottom.blue), alpha: a)
    }

    /// WCAG relative luminance (0 black ... 1 white).
    static func luminance(_ color: PageColor) -> Double {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
    }

    /// Dark: white text has more contrast on it than black text (the crossover is L ≈ 0.179).
    static func isDark(_ color: PageColor) -> Bool {
        let l = luminance(color)
        return (1.05) / (l + 0.05) > (l + 0.05) / 0.05
    }

    /// WCAG contrast ratio between two opaque colours (1 ... 21).
    static func contrast(_ a: PageColor, _ b: PageColor) -> Double {
        let la = luminance(a), lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /// The small grey line's colour on `tint`: the app's grey for that look while it still reads
    /// (3:1, about what it has on the app's own background), else the look's text colour laid
    /// over the tint, from 70% up until it reads (mid-tone pages: grey, blue-500...). The look's
    /// text colour itself always has more than 4.5:1 there (isDark).
    static func secondaryInk(on tint: PageColor) -> PageColor {
        let dark = isDark(tint)
        let grey = dark ? PageColor.greyDark : PageColor.greyLight
        if contrast(grey, tint) >= 3 { return grey }
        var ink = dark ? PageColor.inkDark : PageColor.inkLight
        for alpha in [0.7, 0.8, 0.9] {
            ink.alpha = alpha
            let mixed = over(ink, tint)
            if contrast(mixed, tint) >= 3 { return mixed }
        }
        ink.alpha = 1
        return ink
    }

    // MARK: - CSS colours

    /// `transparent`, `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`, `rgb()` / `rgba()` (commas or spaces,
    /// numbers or percentages, `/ alpha`), `color(srgb r g b / a)`. Anything else: nil.
    static func parse(_ css: String?) -> PageColor? {
        guard let css else { return nil }
        let value = css.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value == "transparent" { return PageColor(red: 0, green: 0, blue: 0, alpha: 0) }
        if value.hasPrefix("#") { return hex(String(value.dropFirst())) }
        guard let open = value.firstIndex(of: "("), value.hasSuffix(")") else { return nil }
        let name = value[..<open].trimmingCharacters(in: .whitespaces)
        let parts = value[value.index(after: open)..<value.index(before: value.endIndex)]
            .split(whereSeparator: { $0 == "," || $0 == "/" || $0 == " " })
            .map(String.init)
        switch name {
        case "rgb", "rgba":
            guard parts.count == 3 || parts.count == 4 else { return nil }
            guard let r = channel(parts[0], scale: 255), let g = channel(parts[1], scale: 255), let b = channel(parts[2], scale: 255) else { return nil }
            let a = parts.count == 4 ? channel(parts[3], scale: 1) : 1
            guard let a else { return nil }
            return PageColor(red: r, green: g, blue: b, alpha: a)
        case "color":
            guard parts.first == "srgb", parts.count == 4 || parts.count == 5 else { return nil }
            guard let r = channel(parts[1], scale: 1), let g = channel(parts[2], scale: 1), let b = channel(parts[3], scale: 1) else { return nil }
            let a = parts.count == 5 ? channel(parts[4], scale: 1) : 1
            guard let a else { return nil }
            return PageColor(red: r, green: g, blue: b, alpha: a)
        default:
            return nil
        }
    }

    private static func visible(_ color: PageColor) -> PageColor? {
        color.alpha > 0.001 ? color : nil
    }

    /// One component: `50%`, or a number over `scale`; `none` is 0. Clamped to 0...1.
    private static func channel(_ text: String, scale: Double) -> Double? {
        if text == "none" { return 0 }
        let value: Double
        if text.hasSuffix("%") {
            guard let percent = Double(text.dropLast()) else { return nil }
            value = percent / 100
        } else {
            guard let number = Double(text) else { return nil }
            value = number / scale
        }
        guard value.isFinite else { return nil }
        return min(max(value, 0), 1)
    }

    private static func hex(_ digits: String) -> PageColor? {
        guard digits.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        let chars = Array(digits)
        func pair(_ i: Int, _ wide: Bool) -> Double {
            let text = wide ? String(chars[i * 2...i * 2 + 1]) : String([chars[i], chars[i]])
            return Double(Int(text, radix: 16) ?? 0) / 255
        }
        switch chars.count {
        case 3, 4:
            return PageColor(red: pair(0, false), green: pair(1, false), blue: pair(2, false), alpha: chars.count == 4 ? pair(3, false) : 1)
        case 6, 8:
            return PageColor(red: pair(0, true), green: pair(1, true), blue: pair(2, true), alpha: chars.count == 8 ? pair(3, true) : 1)
        default:
            return nil
        }
    }
}
