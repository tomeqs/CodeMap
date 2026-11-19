import ProjectDescription

let project = Project(
    name: "Notes",
    targets: [
        .target(
            name: "Notes",
            destinations: .iOS,
            product: .app,
            bundleId: "dev.notes",
            sources: ["Notes/Sources/**"],
            dependencies: [.target(name: "NotesKit"), .external(name: "Alamofire")]
        ),
        .target(name: "NotesKit", destinations: .iOS, product: .framework, bundleId: "dev.notes.kit", sources: "NotesKit/Sources/**"),
        .target(name: "NotesTests", destinations: .iOS, product: .unitTests, bundleId: "dev.notes.tests", sources: ["Notes/Tests/**"], dependencies: [.target(name: "Notes")]),
    ]
)
