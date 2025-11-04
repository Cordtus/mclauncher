# Automated Deployment Setup

This guide explains how to set up automated deployments when you push to the GitHub repository.

## Overview

The deployment system consists of:
1. **webhook-deploy.js** - Node.js webhook receiver that listens for GitHub push events
2. **webhook-deploy.service** - Systemd service to run the webhook receiver
3. **deploy.sh** - Script that deploys changes to LXD containers

## Setup Instructions

### 1. Install the Webhook Service

On your LXD host machine:

```bash
# Make the webhook script executable
chmod +x ~/repos/mclauncher/webhook-deploy.js

# Copy the systemd service file
sudo cp ~/repos/mclauncher/webhook-deploy.service /etc/systemd/system/

# Generate a secure webhook secret
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "Save this secret: $WEBHOOK_SECRET"

# Edit the service file to add your secret
sudo nano /etc/systemd/system/webhook-deploy.service
# Replace "your-secret-here" with the generated secret

# Reload systemd and start the service
sudo systemctl daemon-reload
sudo systemctl enable webhook-deploy
sudo systemctl start webhook-deploy

# Check status
sudo systemctl status webhook-deploy
```

### 2. Configure GitHub Webhook

1. Go to your GitHub repository: https://github.com/Cordtus/mclauncher
2. Navigate to **Settings → Webhooks → Add webhook**
3. Configure the webhook:
   - **Payload URL**: `http://YOUR_PUBLIC_IP:9000/webhook` or `http://yourdomain.com:9000/webhook`
   - **Content type**: `application/json`
   - **Secret**: Paste the webhook secret you generated
   - **Which events**: Select "Just the push event"
   - **Active**: Check the box
4. Click **Add webhook**

### 3. Configure Firewall (if needed)

If you're using a firewall, allow incoming connections on port 9000:

```bash
# UFW
sudo ufw allow 9000/tcp

# OR iptables
sudo iptables -A INPUT -p tcp --dport 9000 -j ACCEPT
```

### 4. Test the Setup

Make a commit and push to the main branch:

```bash
echo "test" >> README.md
git add README.md
git commit -m "Test automated deployment"
git push
```

Check the webhook service logs:

```bash
sudo journalctl -u webhook-deploy -f
```

You should see:
1. "Received push event for main"
2. Build and deployment progress
3. "Deployment complete!"

## How It Works

1. You push code to GitHub
2. GitHub sends a webhook POST request to your server
3. `webhook-deploy.js` receives the request and verifies the signature
4. If the push is to the `main` branch, it triggers deployment:
   - Pulls latest changes from Git
   - Runs `npm install --workspaces`
   - Runs `npm run build`
   - Runs `./deploy.sh --all` to update containers
5. Your changes are live!

## Monitoring

View real-time logs:
```bash
sudo journalctl -u webhook-deploy -f
```

Check recent deployments:
```bash
sudo journalctl -u webhook-deploy --since "1 hour ago"
```

Restart the service:
```bash
sudo systemctl restart webhook-deploy
```

## Security Notes

- The webhook secret should be kept private
- The service runs as user `bv` with limited permissions
- GitHub's signature verification prevents unauthorized deployments
- Consider using a reverse proxy (Caddy/Nginx) for HTTPS on port 9000

## Troubleshooting

**Deployment not triggering:**
- Check webhook delivery in GitHub Settings → Webhooks → Recent Deliveries
- Verify the service is running: `sudo systemctl status webhook-deploy`
- Check logs: `sudo journalctl -u webhook-deploy -f`

**Build failures:**
- Ensure all dependencies are installed
- Check file permissions
- Verify `deploy.sh` is executable

**Container not updating:**
- Check that `deploy.sh` completes successfully
- Verify containers are running: `lxc list`
- Check container logs for errors
