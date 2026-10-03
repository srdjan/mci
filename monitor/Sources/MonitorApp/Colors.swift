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

/// A menu bar image is a template (monochrome) unless it says otherwise. A palette with one
/// color also fills the cut-out parts, such as the checkmark, so the symbol is tinted instead.
func coloredSymbol(_ kind: DisplayKind) -> NSImage {
    let configuration = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
    guard
        let symbol = NSImage(systemSymbolName: kind.symbol, accessibilityDescription: kind.label)?
            .withSymbolConfiguration(configuration)
    else { return NSImage(size: NSSize(width: 16, height: 16)) }
    let color = kind.color.nsColor
    let image = NSImage(size: symbol.size, flipped: false) { rect in
        symbol.draw(in: rect)
        color.set()
        rect.fill(using: .sourceAtop)
        return true
    }
    image.accessibilityDescription = kind.label
    image.isTemplate = false
    return image
}
