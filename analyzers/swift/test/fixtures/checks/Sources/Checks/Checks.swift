import Foundation
import UIKit

enum Failure: Error { case bad }

final class Widget: UIViewController {
    var onChange: (() -> Void)?
    var name: String!
    @IBOutlet weak var label: UILabel!
    var count = 0
    var ratio = 0.5

    lazy var handler: () -> Void = { self.refresh() }

    func refresh() {}

    func bind() {
        self.onChange = { self.refresh() }
        self.onChange = { [weak self] in self?.refresh() }
        let local = { self.refresh() }
        local()
    }

    func run(_ data: Data, value: Double) throws -> Int {
        count = count
        if count == count { print("same") }
        if true { print("always") }
        let json = try! JSONSerialization.jsonObject(with: data)
        let dict = json as! [String: Any]
        try? save()
        _ = try? save()
        let saved = try? save()
        if value == 0.1 { print("float") }
        if ratio == 1 { print("whole") }
        DispatchQueue.main.sync { print("main") }
        do {
            try save()
        } catch {
        }
        do {
            try save()
        } catch {
            // ignored on purpose: the cache is rebuilt
        }
        _ = (dict, saved)
        return 0
        print("never")
    }

    func save() throws { throw Failure.bad }

    func later() -> Int {
        fatalError("not implemented")
    }

    func guarded() {
        if Thread.isMainThread { refresh() } else { DispatchQueue.main.sync { refresh() } }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

struct Plain {
    var value: Int!
    func fine(_ x: Int) -> Bool {
        guard x > 0 else { return false }
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}

final class Narrowed {
    var observed = 0 { didSet { print(observed) } }
    func refire() { self.observed = self.observed }
    func value() -> String {
        return
            "the value"
    }
    func pause() async {
        do { try await Task.sleep(nanoseconds: 1) } catch {}
        try? await Task.sleep(nanoseconds: 1)
    }
}

enum Mode { case a, b }
func describe(_ mode: Mode) -> String {
    switch mode {
    case .a:
        fatalError("unexpected")
        break
    case .b:
        return "b"
    }
}
