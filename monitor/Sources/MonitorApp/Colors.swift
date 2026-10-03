import AppKit
import MonitorCore
import SwiftUI

extension DisplayColor {
    var nsColor: NSColor {
        switch self {
        case .green: .systemGreen
        case .red: .systemRed
        case .orange: .systemOrange
        case .blue: .systemBlue
        case .gray: .systemGray
        }
    }

    var color: Color { Color(nsColor: nsColor) }
}

/// A menu bar image is a template (monochrome) unless it says otherwise.
func coloredSymbol(_ kind: DisplayKind) -> NSImage {
    let base = NSImage(systemSymbolName: kind.symbol, accessibilityDescription: kind.label)
    let configuration = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
        .applying(NSImage.SymbolConfiguration(paletteColors: [kind.color.nsColor]))
    let image = base?.withSymbolConfiguration(configuration)
        ?? NSImage(size: NSSize(width: 16, height: 16))
    image.isTemplate = false
    return image
}
