import AppKit
import MonitorCore

private let logFontSize: CGFloat = 12

/// An `NSColor` for an ANSI color. System colors adapt to light and dark mode.
func ansiNSColor(_ color: AnsiColor) -> NSColor {
    switch color {
    case .standard(let code): return standardColor(code)
    case .bright(let code): return brightColor(code)
    case .indexed(let index):
        if index < 8 { return standardColor(index) }
        if index < 16 { return brightColor(index - 8) }
        guard let rgb = xtermRGB(index) else { return .labelColor }
        return NSColor(
            srgbRed: CGFloat(rgb.red) / 255, green: CGFloat(rgb.green) / 255,
            blue: CGFloat(rgb.blue) / 255, alpha: 1)
    }
}

private func standardColor(_ code: Int) -> NSColor {
    switch code {
    case 0: .labelColor
    case 1: .systemRed
    case 2: .systemGreen
    case 3: .systemBrown  // systemYellow is too pale on a light background
    case 4: .systemBlue
    case 5: .systemPurple
    case 6: .systemTeal
    default: .secondaryLabelColor
    }
}

private func brightColor(_ code: Int) -> NSColor {
    switch code {
    case 0: .systemGray
    case 1: .systemRed
    case 2: .systemMint
    case 3: .systemYellow
    case 4: .systemBlue
    case 5: .systemPink
    case 6: .systemCyan
    default: .labelColor
    }
}

func logAttributedString(_ runs: [StyledRun]) -> NSAttributedString {
    let regular = NSFont.monospacedSystemFont(ofSize: logFontSize, weight: .regular)
    let bold = NSFont.monospacedSystemFont(ofSize: logFontSize, weight: .bold)
    let result = NSMutableAttributedString()
    for run in runs {
        result.append(
            NSAttributedString(
                string: run.text,
                attributes: [
                    .font: run.bold ? bold : regular,
                    .foregroundColor: run.foreground.map(ansiNSColor) ?? NSColor.labelColor,
                ]))
    }
    return result
}

private func messageText(_ error: LogError) -> String {
    switch error {
    case .missing: "No log yet: .mci/ci/latest.log does not exist."
    case .notFile: "latest.log is not a regular file, so the monitor does not read it."
    case .read(let reason): "Cannot read latest.log: \(reason)"
    }
}

/// Shows `.mci/ci/latest.log` of one repository in one reused window. The file is only read.
@MainActor
final class LogWindowPresenter: NSObject {
    private var window: NSWindow?
    private var workspace: String?
    private lazy var textView = NSTextView()
    private lazy var notice = NSTextField(labelWithString: "")

    func show(workspace: String) {
        NSApp.keyWindow?.orderOut(nil)
        self.workspace = workspace
        let window = self.window ?? makeWindow()
        self.window = window
        window.title = "latest.log (\(repositoryName(workspace)))"
        load()
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func reload(_ sender: Any?) { load() }

    @objc private func revealInFinder(_ sender: Any?) {
        guard let workspace else { return }
        let path = logPath(workspace: workspace)
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: workspace, isDirectory: true))
        }
    }

    private func load() {
        guard let workspace else { return }
        switch readLogTail(workspace: workspace) {
        case .success(let tail):
            let limit = logTailLimit / 1024
            notice.stringValue = tail.truncated ? "Showing the last \(limit) KiB." : ""
            notice.isHidden = !tail.truncated
            textView.textStorage?.setAttributedString(logAttributedString(parseAnsi(tail.text)))
        case .failure(let error):
            notice.isHidden = true
            textView.textStorage?.setAttributedString(
                NSAttributedString(
                    string: messageText(error),
                    attributes: [
                        .font: NSFont.systemFont(ofSize: NSFont.systemFontSize),
                        .foregroundColor: NSColor.secondaryLabelColor,
                    ]))
        }
        scrollToEnd()
    }

    private func scrollToEnd() {
        textView.scrollToEndOfDocument(nil)
        // The layout of a long text can finish after this call.
        DispatchQueue.main.async { [textView] in textView.scrollToEndOfDocument(nil) }
    }

    private func makeWindow() -> NSWindow {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.usesFontPanel = false
        textView.drawsBackground = true
        textView.backgroundColor = .textBackgroundColor
        textView.textContainerInset = NSSize(width: 8, height: 8)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        scroll.documentView = textView

        notice.textColor = .secondaryLabelColor
        notice.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        notice.isHidden = true

        let reloadButton = NSButton(title: "Reload", target: self, action: #selector(reload(_:)))
        let finderButton = NSButton(
            title: "Show in Finder", target: self, action: #selector(revealInFinder(_:)))
        let bar = NSStackView(views: [reloadButton, finderButton])
        bar.orientation = .horizontal
        bar.spacing = 8
        bar.edgeInsets = NSEdgeInsets(top: 6, left: 10, bottom: 6, right: 10)

        let content = NSStackView(views: [notice, scroll, bar])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 0
        notice.setContentHuggingPriority(.required, for: .vertical)
        bar.setContentHuggingPriority(.required, for: .vertical)
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        scroll.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 560),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 360, height: 200)
        window.contentView = content
        window.center()
        return window
    }
}
