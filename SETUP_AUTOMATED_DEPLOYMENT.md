# Automated Deployment Setup Guide

This guide sets up automatic deployment when you push to the `feature/advanced-mod-management` branch.

## Prerequisites

- Git repository with remote (GitHub, GitLab, etc.)
- SSH access to 192.168.0.170
- Sudo privileges on the host

## Option 1: GitHub Webhook (Recommended)

### Step 1: Configure Sudo Permissions

The deployment script needs sudo to push files to LXD containers. Add passwordless sudo for the deployment script:

```bash
# SSH into the host
ssh cordt@192.168.0.170

# Add sudo permission for lxc commands
sudo visudo -f /etc/sudoers.d/mclauncher-deploy
```

Add this line:
```
cordt ALL=(ALL) NOPASSWD: /home/cordt/repos/mclauncher/deploy-updates.sh, /snap/bin/lxc
```

Save and exit (Ctrl+X, Y, Enter).

### Step 2: Generate Webhook Secret

```bash
# Generate a secure random secret
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "SAVE THIS SECRET: $WEBHOOK_SECRET"
```

### Step 3: Update Service File

```bash
cd ~/repos/mclauncher

# Edit the service file with your secret
nano webhook-deploy.service
```

Replace `CHANGE_THIS_SECRET` with the secret you generated.

### Step 4: Install the Webhook Service

```bash
# Copy service file to systemd
sudo cp webhook-deploy.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable and start the service
sudo systemctl enable webhook-deploy
sudo systemctl start webhook-deploy

# Check status
sudo systemctl status webhook-deploy
```

You should see "Webhook server listening on port 9000".

### Step 5: Configure Firewall (if using UFW)

```bash
# Allow webhook port
sudo ufw allow 9000/tcp comment 'GitHub Webhook'

# Check status
sudo ufw status
```

### Step 6: Set Up GitHub Webhook

1. Go to your GitHub repository
2. Navigate to **Settings → Webhooks → Add webhook**
3. Configure:
   - **Payload URL**: `http://192.168.0.170:9000/webhook`
   - **Content type**: `application/json`
   - **Secret**: Paste your webhook secret
   - **Which events**: Just the push event
   - **Active**: ✓ Checked

4. Click **Add webhook**

### Step 7: Test the Automation

```bash
# Make a small change
echo "# Test automated deployment" >> README.md
git add README.md
git commit -m "Test: automated deployment"
git push origin feature/advanced-mod-management
```

Watch the deployment happen:
```bash
ssh cordt@192.168.0.170
sudo journalctl -u webhook-deploy -f
```

You should see:
1. "Received push event for feature/advanced-mod-management"
2. "Pulling latest changes..."
3. "Installing dependencies..."
4. "Building..."
5. "Deploying to containers..."
6. "Deployment complete!"

### Step 8: Verify Deployment

```bash
# Check containers updated
lxc exec mc-manager -- systemctl status mc-manager
lxc exec mc-server-1 -- systemctl status mc-agent

# Check recent logs
lxc exec mc-manager -- journalctl -u mc-manager -n 20 --no-pager
```

## Option 2: GitHub Actions (Alternative)

If you don't want to expose port 9000, use GitHub Actions with SSH deployment:

### Step 1: Generate SSH Key for Actions

On the LXD host:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/github-actions -N ""
cat ~/.ssh/github-actions.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/github-actions  # Copy this private key
```

### Step 2: Add Secrets to GitHub

In your GitHub repository:
1. Go to **Settings → Secrets and variables → Actions**
2. Add these secrets:
   - `SSH_PRIVATE_KEY`: The private key you copied
   - `SSH_HOST`: `192.168.0.170`
   - `SSH_USER`: `cordt`

### Step 3: Create GitHub Actions Workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to LXD Containers

on:
  push:
    branches:
      - feature/advanced-mod-management

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Deploy to server
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd ~/repos/mclauncher
            git pull origin feature/advanced-mod-management
            npm install
            npm run build
            sudo ./deploy-updates.sh
```

Commit and push this file - deployments will happen automatically on every push!

## Monitoring Deployments

### View Real-Time Logs (Webhook Method)

```bash
ssh cordt@192.168.0.170
sudo journalctl -u webhook-deploy -f
```

### View Recent Deployments

```bash
# Last hour
sudo journalctl -u webhook-deploy --since "1 hour ago"

# Last 50 lines
sudo journalctl -u webhook-deploy -n 50
```

### Check Container Status

```bash
# Management container
lxc exec mc-manager -- systemctl status mc-manager
lxc exec mc-manager -- journalctl -u mc-manager -n 30 --no-pager

# Server container
lxc exec mc-server-1 -- systemctl status mc-agent
lxc exec mc-server-1 -- journalctl -u mc-agent -n 30 --no-pager
```

## Troubleshooting

### Webhook Not Triggering

1. **Check webhook service is running:**
   ```bash
   sudo systemctl status webhook-deploy
   ```

2. **Check GitHub webhook deliveries:**
   - Go to Settings → Webhooks → Click your webhook
   - View "Recent Deliveries" tab
   - Check for errors

3. **Check firewall:**
   ```bash
   sudo ufw status | grep 9000
   curl http://192.168.0.170:9000/health  # Should return "OK"
   ```

### Deployment Fails

1. **Check logs for errors:**
   ```bash
   sudo journalctl -u webhook-deploy -n 100 --no-pager | grep -i error
   ```

2. **Common issues:**
   - **Permission denied**: Check sudoers file
   - **Build fails**: Run `npm install` manually first
   - **Git pull fails**: Check SSH keys or use HTTPS

3. **Test deployment manually:**
   ```bash
   cd ~/repos/mclauncher
   git pull
   npm install
   npm run build
   sudo ./deploy-updates.sh
   ```

### Container Not Updating

1. **Verify files were pushed:**
   ```bash
   lxc exec mc-manager -- ls -la /opt/mc-lxd-manager/apps/server/dist/
   lxc exec mc-manager -- ls -la /opt/mc-lxd-manager/apps/web/dist/
   lxc exec mc-server-1 -- ls -la /opt/mc-agent/dist/services/
   ```

2. **Check for new files:**
   ```bash
   # New services should exist
   lxc exec mc-server-1 -- ls /opt/mc-agent/dist/services/mojang.js
   lxc exec mc-server-1 -- ls /opt/mc-agent/dist/services/properties-parser.js
   ```

3. **Restart services manually:**
   ```bash
   lxc exec mc-manager -- systemctl restart mc-manager
   lxc exec mc-server-1 -- systemctl restart mc-agent
   ```

## Security Notes

- Keep your webhook secret private
- Consider using a reverse proxy (Caddy/Nginx) with HTTPS for port 9000
- The webhook service runs as user `cordt` with limited sudo permissions
- GitHub signature verification prevents unauthorized deployments
- Only the specific branch (`feature/advanced-mod-management`) triggers deployment

## Updating the Webhook Service

If you need to change settings:

```bash
# Edit service file
sudo nano /etc/systemd/system/webhook-deploy.service

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart webhook-deploy

# Check status
sudo systemctl status webhook-deploy
```

## Disabling Automated Deployment

```bash
# Stop and disable the service
sudo systemctl stop webhook-deploy
sudo systemctl disable webhook-deploy

# Remove webhook from GitHub
# Go to Settings → Webhooks → Delete webhook
```

## What Gets Deployed

Every push triggers:
1. ✅ Git pull (latest code)
2. ✅ npm install (dependencies)
3. ✅ npm run build (compile TypeScript, bundle React)
4. ✅ Copy to mc-manager container (web UI + server)
5. ✅ Copy to mc-server-1 container (agent)
6. ✅ Restart both services

**Deploy time**: ~2-3 minutes from push to live

## Next Steps

After setup:
1. Make a test commit and push
2. Watch the logs to verify it works
3. Access http://192.168.0.170:8080 to see your changes
4. Future pushes will deploy automatically!
