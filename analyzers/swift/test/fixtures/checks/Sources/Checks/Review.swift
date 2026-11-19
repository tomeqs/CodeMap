import Foundation

final class Box {
    var onChange: (() -> Void)?
    weak var delegate: AnyObject?
    var watched = 0 {
        didSet { var old: String! = nil; _ = old }
    }

    func abort() {}
    func cancel() {
        abort()
        print("still runs")
    }

    func load() {
        fatalError("Could not load the todo list from disk")
    }

    func gate() {
        guard false else { return }
    }

    func compare(_ v: Double) -> Bool { v == -0.5 }

    func make() {
        final class Local { var name: String! }
        _ = Local()
    }

    func hop() {
        if Thread.isMainThread { return }
        DispatchQueue.global().async { DispatchQueue.main.sync { print("x") } }
    }
}

extension Box {
    func bind() {
        self.onChange = { self.cancel() }
        self.onChange = { [weak delegate] in self.cancel(); _ = delegate }
        self.onChange = { _ = Int.self }
    }
}

struct Counter {
    var onTick: (() -> Void)?
}

extension Counter {
    mutating func start() { self.onTick = { print(self) } }
}
