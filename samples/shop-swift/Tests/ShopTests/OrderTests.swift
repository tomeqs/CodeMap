import XCTest
@testable import ShopDomain

final class OrderTests: XCTestCase {
    private var book: Product!

    override func setUp() {
        book = Product(sku: "B-1", name: "A book", price: Money(cents: 1_000))
    }

    func testTheSameProductAddsToItsLine() {
        let order = Order()
        order.add(book)
        order.add(book, quantity: 2)
        XCTAssertEqual(order.lines.count, 1)
        XCTAssertEqual(order.total, Money(cents: 3_000))
    }
}
