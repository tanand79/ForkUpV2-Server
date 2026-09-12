#!/usr/bin/env bash
# Bootstrap ForkUp V2 API on EC2: Node, deps, nginx, certbot, pm2.
# Domain: forkup2.duckdns.org → localhost:3001
set -euo pipefail

APP_DIR="${HOME}/ForkUpV2-Server"
DOMAIN="forkup2.duckdns.org"
EMAIL="admin@forkup.local"
PORT=3001

cd "$APP_DIR"

echo "==> Installing Node.js 22 (NodeSource) if missing"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo "==> Installing nginx + certbot"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx

echo "==> npm ci + ensure dist"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
if [ ! -f dist/main.js ]; then
  npm install
  npm run build
fi

echo "==> Install pm2"
sudo npm install -g pm2

echo "==> Start / restart API with pm2"
pm2 delete forkup-api 2>/dev/null || true
pm2 start dist/main.js --name forkup-api --cwd "$APP_DIR"
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u ubuntu --hp /home/ubuntu | tail -n 1 | bash || true

echo "==> Nginx site for ${DOMAIN}"
sudo tee /etc/nginx/sites-available/forkup2 >/dev/null <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/forkup2 /etc/nginx/sites-enabled/forkup2
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl restart nginx

echo "==> Attempt Let's Encrypt (needs SG ports 80+443 open)"
if sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
  echo "SSL OK for https://${DOMAIN}"
else
  echo "CERTBOT_FAILED: open AWS Security Group inbound TCP 80 and 443 to 0.0.0.0/0, then rerun:"
  echo "  sudo certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m ${EMAIL} --redirect"
fi

echo "==> Health checks"
sleep 2
curl -sS -o /tmp/health.txt -w "local_http=%{http_code}\n" "http://127.0.0.1:${PORT}/api/health" || curl -sS -o /tmp/health.txt -w "local_root=%{http_code}\n" "http://127.0.0.1:${PORT}/" || true
head -c 200 /tmp/health.txt 2>/dev/null || true
echo
pm2 status
echo "BOOTSTRAP_DONE"
