'use strict';

// Runs inside VS Code (see run.js): the extension on the Shop sample, with the real webview and analyzer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

async function until(what, condition, ms = 240000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function run() {
  const extension = vscode.extensions.getExtension('tomeqs.codemap');
  assert.ok(extension, 'extension is installed');
  const { controller } = await extension.activate();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const orderFile = path.join(root, 'src', 'Shop.Domain', 'Orders', 'Order.cs');

  console.log('· open the map');
  await vscode.commands.executeCommand('codemap.open');
  assert.ok(controller.panel, 'panel created');
  await until('the analysis', () => controller.doc);
  assert.ok(controller.doc.nodes.some((n) => n.id === 'T:Shop.Domain.Orders.Order'), 'Order is on the map');
  // The viewer booted inside the webview (CSP, nonce, bridge) and asked for the graph.
  await until('the viewer to start in the webview', () => controller.ready || controller.fatal, 60000);
  assert.ok(controller.ready, `the map did not start: ${controller.fatal}`);

  console.log('· editor → map');
  const document = await vscode.workspace.openTextDocument(orderFile);
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  const line = document.getText().split('\n').findIndex((l) => l.includes('public void AddLine'));
  editor.selection = new vscode.Selection(line + 1, 4, line + 1, 4);
  const posted = [];
  const original = controller.panel.webview.postMessage.bind(controller.panel.webview);
  controller.panel.webview.postMessage = (message) => (posted.push(message), original(message));
  await vscode.commands.executeCommand('codemap.revealInMap');
  assert.deepEqual(posted.at(-1), { type: 'reveal', id: 'M:Shop.Domain.Orders.Order.AddLine(Shop.Domain.Catalog.Product,System.Int32)' });
  await vscode.commands.executeCommand('codemap.callFlow');
  assert.equal(posted.at(-1).type, 'flow');

  console.log('· map → editor');
  await controller.onMessage({ type: 'openFile', file: 'src/Shop.Domain/Catalog/Product.cs', line: 3 });
  await until('the file to open', () => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('Product.cs'), 10000);
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 2);

  console.log('· live update on save');
  const before = controller.doc;
  const text = fs.readFileSync(orderFile, 'utf8');
  try {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(document.lineCount, 0), '\npublic sealed class LiveAddedType { }\n');
    await vscode.workspace.applyEdit(edit);
    await document.save();
    await until('the map to refresh', () => controller.doc !== before && !controller.running, 240000);
    assert.ok(controller.doc.nodes.some((n) => n.id === 'T:Shop.Domain.Orders.LiveAddedType'), 'the new type is on the refreshed map');
    assert.ok(posted.some((m) => m.type === 'load' && m.preserve), 'refresh keeps the view');
  } finally {
    fs.writeFileSync(orderFile, text);
  }

  console.log('· close');
  controller.panel.dispose();
  assert.equal(controller.panel, null);
  console.log('Integration tests passed.');
}

module.exports = { run };
