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
  // keep what the extension writes to its output channel, to show it if something fails
  const log = [];
  const appendLine = controller.output.appendLine.bind(controller.output);
  controller.output.appendLine = (line) => (log.push(line), appendLine(line));
  controller.diagnostics = log;
  try {
    await scenario(controller, log);
  } catch (error) {
    console.log('--- CodeMap output ---\n' + log.join('\n'));
    throw error;
  }
}

async function scenario(controller) {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const orderFile = path.join(root, 'src', 'Shop.Domain', 'Orders', 'Order.cs');

  console.log('· open the map');
  await vscode.commands.executeCommand('codemap.open');
  assert.ok(controller.panel, 'panel created');
  await until('the analysis', () => controller.doc);
  assert.ok(controller.doc.nodes.some((n) => n.id === 'T:Shop.Domain.Orders.Order'), 'Order is on the map');
  // The viewer booted inside the webview (CSP, nonce, bridge) and asked for the graph.
  let step = 'open';
  const mark = (name) => {
    step = name;
    console.log(`· ${name}`);
    controller.diagnostics.push(`step ${name}: panel=${!!controller.panel} visible=${controller.panel?.visible} column=${controller.panel?.viewColumn}`);
  };
  controller.panel.onDidDispose(() => controller.diagnostics.push(`map panel disposed during "${step}"`));
  await until('the viewer to start in the webview', () => controller.ready || controller.fatal, 60000);
  assert.ok(controller.ready, `the map did not start: ${controller.fatal}`);

  mark('editor → map');
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
  controller.diagnostics.push(`after call flow: panel=${!!controller.panel}`);

  mark('map → editor');
  await controller.onMessage({ type: 'openFile', file: 'src/Shop.Domain/Catalog/Product.cs', line: 3 });
  await until('the file to open', () => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('Product.cs'), 10000);
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 2);

  mark('live update on save');
  const before = controller.doc;
  const text = fs.readFileSync(orderFile, 'utf8');
  const log = controller.diagnostics;
  const saved = vscode.workspace.onDidSaveTextDocument((d) => log.push(`test saw save of ${d.uri.fsPath}`));
  const onFileChanged = controller.onFileChanged.bind(controller);
  controller.onFileChanged = (file) => {
    log.push(`onFileChanged ${file} panel=${!!controller.panel} doc=${!!controller.doc} root=${controller.doc?.source?.root} live=${controller.settings.get('liveUpdate', true)}`);
    onFileChanged(file);
  };
  try {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.lineAt(document.lineCount - 1).range.end, '\npublic sealed class LiveAddedType { }\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'edit applied');
    assert.ok(await document.save(), 'file saved');
    await until('the map to refresh', () => controller.doc !== before && !controller.running, 120000);
    assert.ok(controller.doc.nodes.some((n) => n.id === 'T:Shop.Domain.Orders.LiveAddedType'), 'the new type is on the refreshed map');
    assert.ok(posted.some((m) => m.type === 'load' && m.preserve), 'refresh keeps the view');
  } finally {
    saved.dispose();
    fs.writeFileSync(orderFile, text);
  }

  mark('close');
  controller.panel.dispose();
  assert.equal(controller.panel, null);
  console.log('Integration tests passed.');
}

module.exports = { run };
