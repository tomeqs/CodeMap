'use strict';

const crypto = require('crypto');

function nonce() {
  return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/**
 * The single-file viewer as webview HTML: a strict Content-Security-Policy, and a nonce on the one
 * script it runs. The viewer receives the graph by postMessage, so it needs no network access.
 */
function webviewHtml(viewerHtml, { cspSource, scriptNonce = nonce() }) {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data: blob:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${scriptNonce}'`,
  ].join('; ');

  const script = '<script type="module" crossorigin>';
  if (!viewerHtml.includes(script) || !/<head>/i.test(viewerHtml)) throw new Error('viewer.html does not look like the CodeMap viewer build.');
  return viewerHtml
    .replace(/<head>/i, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`)
    .replace(script, `<script type="module" nonce="${scriptNonce}">`);
}

const PLACEHOLDER = '<script id="codemap-data" type="application/json">null</script>';

/** A self-contained HTML map with the graph inside, like `codemap -f html` writes (for opening in a browser). */
function standaloneHtml(viewerHtml, doc) {
  const index = viewerHtml.indexOf(PLACEHOLDER);
  if (index < 0) throw new Error('viewer.html does not contain the CodeMap data placeholder.');
  const json = JSON.stringify(doc).replace(/<\//g, '<\\/'); // "</" must not appear inside a <script> element
  const name = String(doc?.source?.name ?? '').replace(/[<>&"]/g, '');
  return viewerHtml.slice(0, index).replace('<title>CodeMap</title>', `<title>CodeMap · ${name}</title>`)
    + `<script id="codemap-data" type="application/json">${json}</script>`
    + viewerHtml.slice(index + PLACEHOLDER.length);
}

module.exports = { nonce, standaloneHtml, webviewHtml };
