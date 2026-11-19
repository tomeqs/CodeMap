import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlist } from '../src/projects/plist.mjs';

test('old-style property lists: dictionaries, arrays, bare and quoted strings, comments', () => {
  const plist = parsePlist(`// !$*UTF8*$!
{
	archiveVersion = 1;
	objects = {
		A1 /* Order.swift in Sources */ = {isa = PBXBuildFile; fileRef = F1 /* Order.swift */; };
		F1 = {isa = PBXFileReference; path = "My App/Order.swift"; sourceTree = "<group>"; name = 'quoted \\"name\\"'; };
		P1 = {isa = PBXSourcesBuildPhase; files = (A1, /* a comment */ A2, ); empty = (); data = <0fbd7779 a1>; };
	};
	rootObject = R1 /* Project object */;
}`);
  assert.equal(plist.archiveVersion, '1');
  assert.equal(plist.rootObject, 'R1');
  assert.deepEqual(plist.objects.A1, { isa: 'PBXBuildFile', fileRef: 'F1' });
  assert.equal(plist.objects.F1.path, 'My App/Order.swift');
  assert.equal(plist.objects.F1.sourceTree, '<group>');
  assert.equal(plist.objects.F1.name, 'quoted "name"');
  assert.deepEqual(plist.objects.P1.files, ['A1', 'A2']);
  assert.deepEqual(plist.objects.P1.empty, []);
  assert.equal(plist.objects.P1.data, '<0fbd7779 a1>');
});

test('a broken list says where', () => {
  assert.throws(() => parsePlist('{\n  a = 1;\n  b = (1, 2\n}'), /line 4/);
  assert.throws(() => parsePlist('{ a = 1 b = 2; }'), /no ';' after the value of 'a'/);
  assert.throws(() => parsePlist('{ a = "x; }'), /unclosed string/);
});
