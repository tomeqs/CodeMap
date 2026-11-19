import XCTest
import Testing
@testable import Shop

final class CartTests: XCTestCase {
    override func setUp() {}
    func testAdds() { helper() }
    private func helper() {}
}

@Suite struct CartSuite {
    @Test func adds() {}
}

@Test func freeStanding() {}
