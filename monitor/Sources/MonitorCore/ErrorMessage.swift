public struct ErrorMessage: Equatable, Sendable {
    public private(set) var text: String?
    private var clearedText: String?

    public init(_ text: String? = nil) {
        self.text = text
    }

    public var visibleText: String? {
        text == clearedText ? nil : text
    }

    public mutating func update(_ text: String?) {
        if text != self.text { clearedText = nil }
        self.text = text
    }

    public mutating func clear() {
        clearedText = text
    }
}
