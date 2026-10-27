import WidgetKit
import SwiftUI

/// Today's posts on the home screen. The app writes them whenever Today changes.
struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: Date(), snap: .sample) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: Date(), snap: load() ?? .sample)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date().addingTimeInterval(1800)
        completion(Timeline(entries: [Entry(date: Date(), snap: load())], policy: .after(next)))
    }
    private func load() -> TodaySnapshot? {
        guard let data = try? Data(contentsOf: Group.todayFile) else { return nil }
        return try? JSONDecoder().decode(TodaySnapshot.self, from: data)
    }
}

struct Entry: TimelineEntry {
    let date: Date
    let snap: TodaySnapshot?
}

extension TodaySnapshot {
    static let sample = TodaySnapshot(greeting: "Good morning", left: 3, posts: [
        TodayPost(id: "1", title: "Read this before the roadmap review"),
        TodayPost(id: "2", title: "Band takes the stage Thursday night"),
        TodayPost(id: "3", title: "Coastal trails for winter running"),
    ])
}

private let violet = Color(red: 0x7B / 255, green: 0x3F / 255, blue: 0xF2 / 255)
private let gold = Color(red: 1, green: 0xD2 / 255, blue: 0x3F / 255)

struct ShoeboxWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: Entry

    var body: some View {
        let snap = entry.snap
        let open = (snap?.posts ?? []).filter { $0.done != true }
        let shown = Array(open.prefix(family == .systemLarge ? 6 : family == .systemMedium ? 3 : 1))
        VStack(alignment: .leading, spacing: family == .systemSmall ? 6 : 8) {
            HStack {
                Text("Shoebox").font(.system(.headline, design: .serif)).foregroundStyle(violet)
                Spacer()
                Text(open.isEmpty ? "Cleared" : "\(snap?.left ?? open.count) left")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(open.isEmpty ? gold : violet.opacity(0.15), in: Capsule())
            }
            if snap == nil {
                Text("Open Shoebox once to fill this in.").font(.footnote).foregroundStyle(.secondary)
            } else if shown.isEmpty {
                Text("Today is cleared.").font(.system(.title3, design: .serif))
            } else {
                ForEach(shown, id: \.self) { post in
                    Link(destination: URL(string: "shoebox://open?id=\(post.id)")!) {
                        HStack(alignment: .top, spacing: 6) {
                            Circle().fill(violet).frame(width: 6, height: 6).padding(.top, 6)
                            Text(post.why?.isEmpty == false ? post.why! : post.title)
                                .font(family == .systemSmall ? .system(.subheadline, design: .serif) : .system(.body, design: .serif))
                                .lineLimit(family == .systemSmall ? 4 : 2)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .widgetURL(URL(string: shown.first.map { "shoebox://open?id=\($0.id)" } ?? "shoebox://open"))
        .containerBackground(for: .widget) { Color(UIColor.systemBackground) }
    }
}

@main
struct ShoeboxWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ShoeboxToday", provider: Provider()) { ShoeboxWidgetView(entry: $0) }
            .configurationDisplayName("Today")
            .description("What's left in Shoebox today.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
