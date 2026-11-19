import Vapor

@main
struct Entry {
    static func main() async throws {
        let app = try await Application.make()
        try routes(app)
        try await app.execute()
    }
}
