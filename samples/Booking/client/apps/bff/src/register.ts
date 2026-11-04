import express from 'express';

const verbose = process.env.LOG_LEVEL === 'debug';
if (verbose) console.log('health checks are logged');
else if (process.env.CI) console.log('running in CI');

/**
 * Edge cases: the app is typed with a qualified name (express.Express), and the route registered here takes the
 * decisions of its handler away from register(), not from the file's own top-level code above.
 */
export function register(app: express.Express) {
  app.get('/health', (req, res) => {
    if (req.query.deep) res.json({ status: 'ok', checks: ['api'] });
    else if (verbose) res.json({ status: 'ok', verbose });
    else res.send('ok');
  });
}
