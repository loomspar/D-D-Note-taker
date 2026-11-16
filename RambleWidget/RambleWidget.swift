import SwiftUI
import WidgetKit

struct RambleEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct RambleProvider: TimelineProvider {
    private static let sample = WidgetSnapshot(
        title: "Video ideas",
        date: .now,
        highlights: [
            "Film the 30-day build as one continuous story",
            "Open with the failed first attempt",
            "Short series testing viewer suggestions",
        ]
    )

    func placeholder(in context: Context) -> RambleEntry {
        RambleEntry(date: .now, snapshot: Self.sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (RambleEntry) -> Void) {
        completion(RambleEntry(date: .now, snapshot: context.isPreview ? Self.sample : WidgetSnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RambleEntry>) -> Void) {
        // The app reloads the widget whenever new notes are written.
        completion(Timeline(entries: [RambleEntry(date: .now, snapshot: WidgetSnapshot.load())], policy: .never))
    }
}

struct RambleWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: RambleEntry

    private var highlightLimit: Int {
        switch family {
        case .systemSmall, .accessoryRectangular: 2
        case .systemMedium: 3
        default: 4
        }
    }

    var body: some View {
        Group {
            if let snapshot = entry.snapshot {
                if family == .accessoryRectangular {
                    lockScreen(snapshot)
                } else {
                    homeScreen(snapshot)
                }
            } else {
                Text("Record a brainstorm and your top ideas show up here.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
        }
        .widgetURL(URL(string: "ramble://latest"))
        .containerBackground(for: .widget) {
            ZStack {
                Color(.systemBackground)
                LinearGradient(
                    colors: [Color.indigo.opacity(0.22), Color.indigo.opacity(0.04)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            }
        }
    }

    private func homeScreen(_ snapshot: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: "lightbulb.fill")
                Text(snapshot.date, format: .dateTime.weekday(.abbreviated).month(.abbreviated).day())
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.indigo)

            if family != .systemSmall {
                Text(snapshot.title)
                    .font(.headline)
                    .lineLimit(1)
            }

            ForEach(snapshot.highlights.prefix(highlightLimit), id: \.self) { highlight in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("•").foregroundStyle(.indigo)
                    Text(highlight)
                        .lineLimit(family == .systemSmall ? 3 : 2)
                }
                .font(family == .systemSmall ? .caption : .subheadline)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func lockScreen(_ snapshot: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Label(snapshot.title, systemImage: "lightbulb.fill")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            ForEach(snapshot.highlights.prefix(highlightLimit), id: \.self) { highlight in
                Text(highlight)
                    .font(.caption2)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

@main
struct RambleWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RambleWidget", provider: RambleProvider()) { entry in
            RambleWidgetView(entry: entry)
        }
        .configurationDisplayName("Latest Brainstorm")
        .description("The top ideas from your most recent brainstorm.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}
