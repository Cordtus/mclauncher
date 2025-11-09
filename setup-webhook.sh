#!/bin/bash
# Quick setup script for automated deployment webhook

set -e

echo "========================================="
echo "MC LXD Manager - Webhook Setup"
echo "========================================="
echo ""

# Check if running on the correct host
if [ ! -d "/home/cordt/repos/mclauncher" ]; then
    echo "Error: This script must be run on the LXD host (192.168.0.170)"
    echo "Current directory: $(pwd)"
    exit 1
fi

# Generate webhook secret
echo "Generating webhook secret..."
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo ""
echo "╔════════════════════════════════════════╗"
echo "║ SAVE THIS SECRET FOR GITHUB WEBHOOK:  ║"
echo "╚════════════════════════════════════════╝"
echo "$WEBHOOK_SECRET"
echo ""
read -p "Press Enter after you've saved the secret..."

# Update service file with secret
echo "Updating service file..."
sed -i "s/CHANGE_THIS_SECRET/$WEBHOOK_SECRET/g" webhook-deploy.service

# Setup sudo permissions
echo ""
echo "Setting up sudo permissions for deployment..."
echo "cordt ALL=(ALL) NOPASSWD: /home/cordt/repos/mclauncher/deploy-updates.sh, /snap/bin/lxc" | sudo tee /etc/sudoers.d/mclauncher-deploy > /dev/null
sudo chmod 0440 /etc/sudoers.d/mclauncher-deploy

# Install systemd service
echo "Installing systemd service..."
sudo cp webhook-deploy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable webhook-deploy
sudo systemctl start webhook-deploy

# Check status
echo ""
echo "Checking service status..."
sleep 1
if sudo systemctl is-active --quiet webhook-deploy; then
    echo "✅ Webhook service is running!"
else
    echo "❌ Webhook service failed to start"
    sudo systemctl status webhook-deploy
    exit 1
fi

# Configure firewall if UFW is active
if sudo ufw status | grep -q "Status: active"; then
    echo ""
    echo "Configuring firewall..."
    sudo ufw allow 9000/tcp comment 'GitHub Webhook'
    echo "✅ Firewall rule added"
fi

echo ""
echo "========================================="
echo "Setup Complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Go to your GitHub repository:"
echo "   https://github.com/YOUR_USERNAME/mclauncher/settings/hooks"
echo ""
echo "2. Click 'Add webhook' and configure:"
echo "   - Payload URL: http://192.168.0.170:9000/webhook"
echo "   - Content type: application/json"
echo "   - Secret: $WEBHOOK_SECRET"
echo "   - Events: Just the push event"
echo ""
echo "3. Test by pushing a commit:"
echo "   git commit --allow-empty -m 'Test webhook'"
echo "   git push origin feature/advanced-mod-management"
echo ""
echo "4. Monitor deployments:"
echo "   sudo journalctl -u webhook-deploy -f"
echo ""
echo "Service commands:"
echo "  Status:  sudo systemctl status webhook-deploy"
echo "  Logs:    sudo journalctl -u webhook-deploy -f"
echo "  Restart: sudo systemctl restart webhook-deploy"
echo ""
