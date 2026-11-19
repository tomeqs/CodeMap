import Shop

let checkout = Checkout(repository: MemoryRepository())
if CommandLine.arguments.count > 1 {
    print(checkout)
}
