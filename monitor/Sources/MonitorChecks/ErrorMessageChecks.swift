import MonitorCore

@MainActor func checkErrorMessages() {
    var message = ErrorMessage()
    equal(message.visibleText, nil, "a new message is empty")
    message.update("Daemon unavailable")
    equal(message.visibleText, "Daemon unavailable", "a failure appears")
    message.clear()
    equal(message.visibleText, nil, "clear hides the message")
    equal(message.text, "Daemon unavailable", "clear preserves the recorded error")
    message.update("Daemon unavailable")
    equal(message.visibleText, nil, "a repeated daemon poll stays cleared")
    message.update("Invalid daemon response")
    equal(message.visibleText, "Invalid daemon response", "a changed failure appears")
    message.clear()
    message.update(nil)
    message.update("Invalid daemon response")
    equal(message.visibleText, "Invalid daemon response", "the same failure appears after recovery")
    message.clear()
    message = ErrorMessage("Invalid daemon response")
    equal(message.visibleText, "Invalid daemon response", "a new action can report the same failure")
}
