import AppKit
import MonitorCore
import SwiftUI

struct PanelView: View {
    let model: MonitorModel
    let loginItem: LoginItem
    let presenter: AddRepositoryPresenter
    let logPresenter: LogWindowPresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if let message = model.message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
                    .help(message)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }
            TimelineView(.periodic(from: .now, by: 1)) { context in
                list(now: context.date)
            }
            Divider()
            footer
        }
        .frame(width: 320)
        // The default panel material lets a dark desktop show through, even in light mode.
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { loginItem.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) {
            _ in loginItem.refresh()
        }
    }

    private var header: some View {
        let combined = model.combined
        return HStack(spacing: 8) {
            Image(systemName: combined.kind.symbol)
                .foregroundStyle(combined.kind.color.color)
                .accessibilityLabel(combined.kind.label)
            Text("mci local CI").font(.headline)
            Spacer()
            if combined.attention > 0 {
                Text("\(combined.attention) need attention")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func list(now: Date) -> some View {
        if model.rows.isEmpty {
            Text("No repositories yet. Use Add repository\u{2026} below.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(12)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(model.rows, id: \.workspace) { row in
                    RowView(row: row, now: now, model: model, logPresenter: logPresenter)
                }
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button("Add repository\u{2026}") {
                presenter.present { model.add(path: $0) }
            }
            .buttonStyle(.plain)
            .padding(.vertical, 2)

            Toggle(
                "Launch at login",
                isOn: Binding(get: { loginItem.isOn }, set: { loginItem.set($0) })
            )
            .toggleStyle(.checkbox)
            if let note = loginItem.note {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
            if let error = loginItem.error {
                Text(error).font(.caption).foregroundStyle(.red).lineLimit(2).help(error)
            }

            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.plain)
                .padding(.vertical, 2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

struct RowView: View {
    let row: RowState
    let now: Date
    let model: MonitorModel
    let logPresenter: LogWindowPresenter

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: row.kind.symbol)
                .foregroundStyle(row.kind.color.color)
                .frame(width: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(row.name).fontWeight(.semibold).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    Text(timeText).font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 4) {
                    Text(row.kind.label)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(row.kind.color.color)
                    if let detail = row.detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .help(detail)
                    }
                    Spacer(minLength: 4)
                    Button { logPresenter.show(workspace: row.workspace) } label: {
                        Image(systemName: "doc.text")
                    }
                    .buttonStyle(.borderless)
                    .help("View log")
                    .accessibilityLabel("View log")
                    Button { model.open(row) } label: { Image(systemName: "folder") }
                        .buttonStyle(.borderless)
                        .help("Open repository")
                        .accessibilityLabel("Open repository")
                    Button { model.remove(path: row.workspace) } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                    .help("Remove from monitor")
                    .accessibilityLabel("Remove from monitor")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private var timeText: String {
        guard let lastRun = row.lastRun else { return "" }
        return row.kind == .running
            ? runningTime(since: lastRun, now: now) : relativeTime(from: lastRun, now: now)
    }
}
