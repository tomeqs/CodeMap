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

module.exports = { nonce, webviewHtml };
