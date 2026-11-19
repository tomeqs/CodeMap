import UIKit

final class CartViewController: UIViewController {
    @IBOutlet private weak var label: UILabel!

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "R", style: .plain, target: self, action: #selector(refresh))
    }

    @IBAction private func tap(_ sender: Any) {}
    @objc private func refresh() {}
    private func unusedHelper() {}
}

final class AppDelegate: UIResponder, UIApplicationDelegate {}
