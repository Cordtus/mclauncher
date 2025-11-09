#!/usr/bin/env node
/**
 * Simple GitHub webhook receiver for automated deployments
 *
 * Setup:
 * 1. Run this on the LXD host: node webhook-deploy.js
 * 2. Configure GitHub webhook:
 *    - URL: http://your-host:9000/webhook
 *    - Content type: application/json
 *    - Secret: (set WEBHOOK_SECRET env var)
 *    - Events: Just push events
 * 3. Install as systemd service (see webhook-deploy.service)
 */

const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT = process.env.WEBHOOK_PORT || 9000;
const SECRET = process.env.WEBHOOK_SECRET || '';
const REPO_PATH = process.env.REPO_PATH || '/home/cordt/repos/mclauncher';
const BRANCH = process.env.DEPLOY_BRANCH || 'feature/advanced-mod-management';

function verifySignature(payload, signature) {
  if (!SECRET) return true; // Skip verification if no secret set
  const hmac = crypto.createHmac('sha256', SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

function deploy() {
  console.log('[%s] Starting deployment...', new Date().toISOString());

  try {
    // Pull latest changes
    console.log('Pulling latest changes...');
    execSync(`cd ${REPO_PATH} && git pull origin ${BRANCH}`, { stdio: 'inherit' });

    // Install dependencies
    console.log('Installing dependencies...');
    execSync(`cd ${REPO_PATH} && npm install --workspaces`, { stdio: 'inherit' });

    // Build
    console.log('Building...');
    execSync(`cd ${REPO_PATH} && npm run build`, { stdio: 'inherit' });

    // Deploy to containers
    console.log('Deploying to containers...');
    execSync(`cd ${REPO_PATH} && sudo ./deploy-updates.sh`, { stdio: 'inherit' });

    console.log('[%s] Deployment complete!', new Date().toISOString());
    return true;
  } catch (error) {
    console.error('[%s] Deployment failed:', new Date().toISOString(), error.message);
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      const signature = req.headers['x-hub-signature-256'];

      if (SECRET && !verifySignature(body, signature)) {
        console.error('[%s] Invalid signature', new Date().toISOString());
        res.writeHead(401);
        res.end('Invalid signature');
        return;
      }

      const payload = JSON.parse(body);

      // Only deploy on push to main branch
      if (payload.ref === `refs/heads/${BRANCH}`) {
        console.log('[%s] Received push event for %s', new Date().toISOString(), BRANCH);

        // Deploy in background
        setTimeout(() => deploy(), 100);

        res.writeHead(200);
        res.end('Deployment triggered');
      } else {
        console.log('[%s] Ignoring push to %s', new Date().toISOString(), payload.ref);
        res.writeHead(200);
        res.end('Ignored (not main branch)');
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log('[%s] Webhook server listening on port %d', new Date().toISOString(), PORT);
  console.log('Watching for pushes to branch: %s', BRANCH);
  console.log('Repository path: %s', REPO_PATH);
  if (SECRET) {
    console.log('Signature verification: ENABLED');
  } else {
    console.warn('WARNING: No webhook secret set - signature verification DISABLED');
  }
});
