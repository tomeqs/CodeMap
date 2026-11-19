import assert from 'node:assert/strict';
import test from 'node:test';
import { parseYaml } from '../src/projects/yaml.mjs';

test("XcodeGen's YAML: nested mappings, sequences of scalars and of mappings, flow lists, quotes, comments", () => {
  const yaml = parseYaml(`
name: Weather # the name
options:
  bundleIdPrefix: "dev.weather"
targets:
  Weather:
    type: application
    sources:
      - path: Weather
        excludes:
          - "Generated/**"
      - Shared
    dependencies:
      - target: WeatherKit
      - package: Charts
        product: Charts
  'WeatherKit':
    sources: [WeatherKit, "Shared/Kit"]
    settings: { base: { SWIFT_VERSION: 5.9 } }
  WeatherTests:
    sources: WeatherTests
list:
- a
- b
`);
  assert.equal(yaml.name, 'Weather');
  assert.equal(yaml.options.bundleIdPrefix, 'dev.weather');
  assert.deepEqual(yaml.targets.Weather.sources, [{ path: 'Weather', excludes: ['Generated/**'] }, 'Shared']);
  assert.deepEqual(yaml.targets.Weather.dependencies, [{ target: 'WeatherKit' }, { package: 'Charts', product: 'Charts' }]);
  assert.deepEqual(yaml.targets.WeatherKit.sources, ['WeatherKit', 'Shared/Kit']);
  assert.deepEqual(yaml.targets.WeatherKit.settings, { base: { SWIFT_VERSION: '5.9' } });
  assert.equal(yaml.targets.WeatherTests.sources, 'WeatherTests');
  assert.deepEqual(yaml.list, ['a', 'b']);
});

test('an empty file is null, a hash inside quotes is not a comment', () => {
  assert.equal(parseYaml('# nothing\n'), null);
  assert.deepEqual(parseYaml('a: "x # y"\nb: x#y\n'), { a: 'x # y', b: 'x#y' });
});
