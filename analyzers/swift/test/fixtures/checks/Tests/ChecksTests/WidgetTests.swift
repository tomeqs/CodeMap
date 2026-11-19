import XCTest
@testable import Checks

final class WidgetTests: XCTestCase {
    var widget: Widget!
    func testRun() throws { _ = try! widget.run(Data(), value: 1) }
}
