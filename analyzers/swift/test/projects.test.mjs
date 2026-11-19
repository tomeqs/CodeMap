import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import test from 'node:test';
import { discover, toPosix } from '../src/discover.mjs';
import { loadParser } from '../src/parser.mjs';
import { readPodfile } from '../src/projects/others.mjs';
import { buildProjects } from '../src/projects/projects.mjs';
import { fixtures, scratch } from './helpers.mjs';

const parser = await loadParser();

/** The projects of a target as { id: { kind, test, executable, files, references, packages } }, files relative to `base`. */
function projectsOf(target, base = target) {
  const { projects, warnings } = buildProjects(discover(join(fixtures, target)), parser.parse);
  const out = {};
  for (const p of projects) {
    out[p.id] = {
      kind: p.kind,
      test: p.test,
      executable: p.executable,
      files: p.files.map((f) => toPosix(relative(join(fixtures, base), f))).sort(),
      references: p.references.map((r) => r.id),
      packages: p.packages,
    };
  }

  return { projects: out, warnings };
}

test('SwiftPM: targets, their default and given folders, excludes, dependencies, and targets added after Package(…)', () => {
  const { projects, warnings } = projectsOf('package/Package.swift', 'package');
  assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(projects), ['Domain', 'Shop', 'ShopTests', 'shop-cli']);
  assert.deepEqual(projects.Domain.files, ['Sources/Domain/Order+Totals.swift', 'Sources/Domain/Order.swift', 'Sources/Domain/Orders/OrderRepository.swift']);
  // path: "Sources/ShopApp", exclude: ["Legacy"]
  assert.deepEqual(projects.Shop.files, ['Sources/ShopApp/Checkout.swift']);
  // A `let` array of dependencies; .product(name:package:) of a package that is not here is that package.
  assert.deepEqual(projects.Shop.references, ['Domain']);
  assert.deepEqual(projects.Shop.packages, ['swift-log']);
  assert.equal(projects.ShopTests.test, true);
  assert.deepEqual(projects.ShopTests.references, ['Shop']);
  // package.targets += [.executableTarget(…)]
  assert.equal(projects['shop-cli'].executable, true);
  assert.deepEqual(projects['shop-cli'].references, ['Shop']);
});

test('a folder with a package and an .xcodeproj of some of the same files: the package wins, the rest is a folder', () => {
  const { projects } = projectsOf('package');
  assert.deepEqual(projects.Domain.files, ['Sources/Domain/Order+Totals.swift', 'Sources/Domain/Order.swift', 'Sources/Domain/Orders/OrderRepository.swift']);
  assert.deepEqual(projects['Shop iOS'].files, ['App/AppDelegate.swift']);
  assert.equal(projects['Shop iOS'].executable, true);
  // What no target holds (an excluded folder, generated code) is the folder's.
  assert.deepEqual(projects.package.files, ['Generated/Strings.generated.swift', 'Sources/ShopApp/Legacy/OldCheckout.swift']);
  assert.equal(projects.package.kind, 'folder');
});

test('the .xcodeproj alone maps its own targets with all their files', () => {
  const { projects } = projectsOf('package/Shop.xcodeproj', 'package');
  assert.deepEqual(Object.keys(projects), ['Shop iOS']);
  assert.deepEqual(projects['Shop iOS'].files, ['App/AppDelegate.swift', 'Sources/Domain/Order.swift']);
});

test('a folder inside a package is read with its package: the same targets, only its files', () => {
  const { projects } = projectsOf('package/Sources/Domain', 'package');
  assert.deepEqual(Object.keys(projects), ['Domain']);
  assert.equal(projects.Domain.files.length, 3);
});

test('Xcode: groups, synchronized folders with exceptions, target dependencies, package products and pods', () => {
  const { projects } = projectsOf('xcode');
  assert.deepEqual(projects.Store.files, ['App/ContentView.swift', 'App/StoreApp.swift', 'Features/Cart/CartView.swift']);
  assert.deepEqual(projects.Store.packages, ['Alamofire', 'Kingfisher', 'Firebase']);
  assert.equal(projects.StoreTests.test, true);
  assert.deepEqual(projects.StoreTests.references, ['Store']);
  // The test target's pods are its own (inherit! :search_paths), not the app's.
  assert.deepEqual(projects.StoreTests.packages, ['Quick']);
  // Excluded from the synchronized folder: the folder's.
  assert.deepEqual(projects.xcode.files, ['Features/Preview/Sample.swift']);
});

test('a workspace maps the projects it lists that exist', () => {
  const { projects } = projectsOf('xcode/Store.xcworkspace', 'xcode');
  assert.deepEqual(Object.keys(projects), ['Store', 'StoreTests']);
});

test('Tuist: targets of Project.swift with their source globs, products and dependencies; its helpers are not code', () => {
  const { projects } = projectsOf('tuist');
  assert.deepEqual(Object.keys(projects).sort(), ['Notes', 'NotesKit', 'NotesTests']);
  assert.deepEqual(projects.Notes.files, ['Notes/Sources/NotesApp.swift']);
  assert.deepEqual(projects.NotesKit.files, ['NotesKit/Sources/Note.swift']);
  assert.equal(projects.Notes.executable, true);
  assert.equal(projects.NotesTests.test, true);
  assert.deepEqual(projects.Notes.references, ['NotesKit']);
  assert.deepEqual(projects.Notes.packages, ['Alamofire']);
});

test('XcodeGen: project.yml targets with their sources, excludes and dependencies', () => {
  const { projects } = projectsOf('xcodegen');
  assert.deepEqual(projects.Weather.files, ['Weather/WeatherApp.swift']);
  assert.deepEqual(projects.Weather.references, ['WeatherKit']);
  assert.deepEqual(projects.Weather.packages, ['Charts']);
  assert.deepEqual(projects.WeatherKit.files, ['WeatherKit/Forecast.swift']);
  assert.equal(projects.WeatherTests.test, true);
  assert.deepEqual(projects.xcodegen.files, ['Weather/Generated/Assets.swift']);
});

test('a podspec: its source files, a test spec, its dependencies', () => {
  const { projects } = projectsOf('podspec');
  assert.deepEqual(projects.Toast.files, ['Sources/Toast/Toast.swift']);
  assert.deepEqual(projects.Toast.packages, ['SnapKit']);
  assert.equal(projects.ToastTests.test, true);
  assert.deepEqual(projects.ToastTests.references, ['Toast']);
});

test('two targets of one name in two packages are told apart by their package', () => {
  const pkg = (name) => `// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "${name}", targets: [.target(name: "Core")])\n`;
  const { dir, dispose } = scratch({
    'A/Package.swift': pkg('A'),
    'A/Sources/Core/a.swift': 'struct A {}\n',
    'B/Package.swift': pkg('B'),
    'B/Sources/Core/b.swift': 'struct B {}\n',
  });
  try {
    const { projects } = buildProjects(discover(dir), parser.parse);
    assert.deepEqual(projects.map((p) => p.id).sort(), ['Core', 'Core (B)']);
  } finally {
    dispose();
  }
});

test('a manifest that cannot be read is a warning, and its files are still mapped', () => {
  const { dir, dispose } = scratch({
    'App.xcodeproj/project.pbxproj': '{ objects = { broken',
    'App/main.swift': 'print("hi")\n',
  });
  try {
    const { projects, warnings } = buildProjects(discover(dir), parser.parse);
    assert.match(warnings[0], /App\.xcodeproj could not be read \(Not a property list/);
    assert.equal(projects[0].kind, 'folder');
    assert.equal(projects[0].files.length, 1);
  } finally {
    dispose();
  }
});

test('targets that list single files claim them, and a deeper pattern of the same kind wins over a broader one', () => {
  const { dir, dispose } = scratch({
    'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P", targets: [.target(name: "A", path: "Sources/A", sources: ["One.swift"])])\n',
    'Sources/A/One.swift': 'struct One {}\n',
    'Sources/A/Two.swift': 'struct Two {}\n',
    'Pod/Toast.podspec': "Pod::Spec.new do |s|\n  s.name = 'Toast'\n  s.source_files = 'Toast.swift'\nend\n",
    'Pod/Toast.swift': 'struct Toast {}\n',
    'App/Project.swift': 'import ProjectDescription\nlet project = Project(name: "App", targets: [.target(name: "App", product: .app, sources: ["Sources/**"]), .target(name: "Feature", product: .framework, sources: ["Sources/Feature/**"])])\n',
    'App/Sources/AppMain.swift': 'struct AppMain {}\n',
    'App/Sources/Feature/Feature.swift': 'struct Feature {}\n',
  });
  try {
    const { projects } = buildProjects(discover(dir), parser.parse);
    const files = Object.fromEntries(projects.map((p) => [p.id, p.files.map((f) => toPosix(relative(dir, f)))]));
    assert.deepEqual(files.A, ['Sources/A/One.swift']);
    assert.deepEqual(files.Toast, ['Pod/Toast.swift']);
    assert.deepEqual(files.App, ['App/Sources/AppMain.swift']);
    assert.deepEqual(files.Feature, ['App/Sources/Feature/Feature.swift']);
  } finally {
    dispose();
  }
});

test('glob roots are native paths, the folders the patterns start in', async () => {
  const { globMatcher } = await import('../src/projects/glob.mjs');
  const base = join(fixtures, 'tuist');
  const matcher = globMatcher(base, ['Notes/Sources/**', 'NotesKit/Sources/Note.swift', 'Other/*.{swift,h}']);
  assert.deepEqual(matcher.roots, [join(base, 'Notes', 'Sources'), join(base, 'NotesKit', 'Sources', 'Note.swift'), join(base, 'Other')]);
  assert.ok(matcher.matches(join(base, 'Notes', 'Sources', 'Deep', 'A.swift')));
  assert.ok(matcher.matches(join(base, 'Other', 'B.h')));
  assert.ok(!matcher.matches(join(base, 'Other', 'Deep', 'B.swift')));
});

test('a Podfile: pods of a def where it is called, pods in an if inside a target', () => {
  const { dir, dispose } = scratch({
    'App.xcodeproj/project.pbxproj': '{ objects = { R = { isa = PBXProject; mainGroup = G; targets = (T); }; G = { isa = PBXGroup; children = (); }; T = { isa = PBXNativeTarget; name = App; productType = "com.apple.product-type.application"; }; }; rootObject = R; }',
    'Podfile': "def shared\n  pod 'Alamofire'\nend\n\ntarget 'App' do\n  shared\n  if ENV['DEBUG']\n    pod 'Debug'\n  end\n  pod 'Kingfisher'\nend\n",
  });
  try {
    const podfile = readPodfile(join(dir, 'Podfile'));
    assert.deepEqual(podfile.targets.get('App'), ['Alamofire', 'Debug', 'Kingfisher']);
  } finally {
    dispose();
  }
});
