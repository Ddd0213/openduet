// A file's type glyph on the app's one tile (file cards, Files rows, the preview's loading
// state), from FileKind so every place shows the same icon for the same type. M9: the
// hand-drawn set (FileKind.glyph through DuetArt(symbol:)), ink plus its clay accent.
import SwiftUI

struct FileGlyphTile: View {
    var kind: FileKind
    var size: CGFloat = 40

    var body: some View {
        DuetArtGlyph(art: DuetArt(symbol: kind.glyph), symbol: kind.glyph, size: size * ArtStyle.tileArtRatio, accented: size >= 24)
            .frame(width: size, height: size)
            .tileBackground(corner: size * ArtStyle.tileCornerRatio)
            .accessibilityHidden(true)
    }
}

extension FileKind {
    /// The type's name for a caption when the file name has no short extension.
    var typeName: Text {
        switch self {
        case .pdf: Text(verbatim: "PDF")
        case .image: Text("Image")
        case .text: Text("Text")
        case .csv: Text(verbatim: "CSV")
        case .document: Text("Document")
        case .spreadsheet: Text("Spreadsheet")
        case .presentation: Text("Presentation")
        case .html: Text("Web page")
        case .archive: Text("Compressed file")
        case .other: Text("File")
        }
    }

    /// "PDF", "XLSX", "MD": the name's extension when it is a short one, else the type's name.
    static func typeLabel(name: String, mime: String) -> Text {
        let ext = (name as NSString).pathExtension
        if (1...5).contains(ext.count), ext.allSatisfy({ $0.isLetter || $0.isNumber }) {
            return Text(verbatim: ext.uppercased())
        }
        return FileKind(mime: mime, name: name).typeName
    }
}

/// A 44 pt floating circle with a glyph: the ✕, Share and keyboard buttons of the full-screen
/// "OpenDuet's computer" view and file preview.
struct FileChromeButton: View {
    var systemImage: String
    var label: Text
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .glyphFont(17)
                .foregroundStyle(Palette.primaryText)
                .contentTransition(.symbolEffect(.replace))
                .floatingCircle(Metrics.headerCircle)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.92))
        .accessibilityLabel(label)
    }
}
