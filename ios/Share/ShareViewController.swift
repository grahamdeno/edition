import UIKit
import UniformTypeIdentifiers

/// "Shoebox" in the share sheet: links, text, photos and files go into the
/// shared Inbox; the app takes them in the next time it opens.
final class ShareViewController: UIViewController {
    private let label = UILabel()
    private let icon = UIImageView(image: UIImage(systemName: "tray.and.arrow.down.fill"))

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        let card = UIView()
        card.backgroundColor = .systemBackground
        card.layer.cornerRadius = 18
        card.translatesAutoresizingMaskIntoConstraints = false
        label.text = "Saving to Shoebox…"
        label.font = .preferredFont(forTextStyle: .headline)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        icon.tintColor = UIColor(red: 0x7B / 255, green: 0x3F / 255, blue: 0xF2 / 255, alpha: 1)
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .largeTitle)
        icon.contentMode = .scaleAspectFit
        icon.translatesAutoresizingMaskIntoConstraints = false
        label.adjustsFontForContentSizeCategory = true
        card.addSubview(icon)
        card.addSubview(label)
        view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(equalToConstant: 260),
            icon.topAnchor.constraint(equalTo: card.topAnchor, constant: 22),
            icon.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            label.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -24),
            label.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
        ])
        Task { await save() }
    }

    private func save() async {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        var count = 0
        for item in items {
            let note = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines)
            for provider in item.attachments ?? [] {
                if await take(provider, note: note) { count += 1 }
            }
        }
        await MainActor.run {
            label.text = count > 0 ? "Saved to Shoebox.\nIt's in New when you open the app." : "Nothing Shoebox can keep here."
            icon.image = UIImage(systemName: count > 0 ? "checkmark.circle.fill" : "exclamationmark.circle")
            if count > 0 { icon.addSymbolEffect(.bounce) }
        }
        try? await Task.sleep(nanoseconds: 900_000_000)
        await MainActor.run { extensionContext?.completeRequest(returningItems: nil) }
    }

    /// One shared thing, written to the Inbox. Returns whether anything was kept.
    private func take(_ p: NSItemProvider, note: String?) async -> Bool {
        if p.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
            if url.isFileURL { return copyFile(url) }
            return write(SharedThing(kind: "url", value: url.absoluteString, title: note))
        }
        if p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            if let url = try? await p.loadItem(forTypeIdentifier: UTType.image.identifier) as? URL { return copyFile(url) }
            if let image = try? await p.loadItem(forTypeIdentifier: UTType.image.identifier) as? UIImage,
               let data = image.jpegData(compressionQuality: 0.88) { return writeData(data, ext: "jpg", mime: "image/jpeg") }
            if let data = try? await p.loadItem(forTypeIdentifier: UTType.image.identifier) as? Data { return writeData(data, ext: "jpg", mime: "image/jpeg") }
        }
        if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
           let text = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
            return write(SharedThing(kind: "text", value: text, title: note))
        }
        if p.hasItemConformingToTypeIdentifier(UTType.data.identifier),
           let url = try? await p.loadItem(forTypeIdentifier: UTType.data.identifier) as? URL, url.isFileURL {
            return copyFile(url)
        }
        return false
    }

    private func stamp() -> String { "\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(6))" }

    private func write(_ thing: SharedThing) -> Bool {
        guard let data = try? JSONEncoder().encode(thing) else { return false }
        return (try? data.write(to: Group.inbox.appendingPathComponent("\(stamp()).json"), options: .atomic)) != nil
    }

    private func writeData(_ data: Data, ext: String, mime: String) -> Bool {
        let name = "\(stamp()).\(ext)"
        guard (try? data.write(to: Group.inbox.appendingPathComponent(name), options: .atomic)) != nil else { return false }
        return write(SharedThing(kind: "file", file: name, mime: mime))
    }

    private func copyFile(_ url: URL) -> Bool {
        let ext = url.pathExtension.isEmpty ? "bin" : url.pathExtension.lowercased()
        let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        guard let data = try? Data(contentsOf: url) else { return false }
        let name = "\(stamp())-\(url.deletingPathExtension().lastPathComponent.prefix(40)).\(ext)"
        guard (try? data.write(to: Group.inbox.appendingPathComponent(name), options: .atomic)) != nil else { return false }
        return write(SharedThing(kind: "file", file: name, mime: mime))
    }
}
