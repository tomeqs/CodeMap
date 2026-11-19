import UIKit
import ShopDomain

final class CheckoutViewController: UIViewController {
    @IBOutlet private weak var totalLabel: UILabel!
    var cart: Cart?

    override func viewDidLoad() {
        super.viewDidLoad()
        totalLabel.text = "\(cart?.order.total.cents ?? 0)"
    }

    @IBAction private func payTapped(_ sender: UIButton) {
        dismiss(animated: true)
    }
}
