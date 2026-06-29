# EC2 Production Setup — Ubuntu + Docker + Traefik DevOps Guide

## Architecture Overview

```
Internet
  │
  ▼
AWS Shield (free, always-on DDoS)
  │
  ▼
Security Group (80/443 only from anywhere, 22 from your IP only)
  │
  ▼
EC2 t3.small — Ubuntu 22.04 LTS
  ├── UFW (host firewall — second layer)
  ├── Fail2ban (SSH + HTTP brute-force blocking)
  ├── CrowdSec (community bot/threat intel)
  │
  └── Docker Engine
        └── Docker Compose stack
              ├── Traefik v3  (ports 80/443 — TLS termination, rate-limit, middleware)
              ├── fleet-server (Node.js app — internal only, never exposed directly)
              ├── PostgreSQL   (optional local dev; prod uses Supabase)
              └── Redis        (session cache, BullMQ, geofence pub/sub)

GitHub Actions CI/CD
  └── Build → Test → Push image → SSH deploy → docker compose up -d
```

---

## Part 1 — AWS Setup (Console / CLI)

### 1.1 Choose the Right t3 Instance

| Tier | vCPU | RAM | Cost (us-east-1) | Recommendation |
|---|---|---|---|---|
| t3.micro | 2 | 1 GB | ~$0.0104/hr (~$7.50/mo) | Too tight for Docker stack |
| **t3.small** | **2** | **2 GB** | **~$0.0208/hr (~$15/mo)** | **Minimum for this stack** |
| t3.medium | 2 | 4 GB | ~$0.0416/hr (~$30/mo) | Comfortable headroom |

Use **t3.small** to start. Enable **T3 Unlimited** CPU credits off (keep Standard to avoid surprise bills).

> Enable a **Spot Instance** if this is a non-critical environment — same spec at 70% discount.

### 1.2 Launch the Instance

```bash
# Via AWS CLI (replace values)
aws ec2 run-instances \
  --image-id ami-0c7217cdde317cfec \   # Ubuntu 22.04 LTS us-east-1
  --instance-type t3.small \
  --key-name fleet-keypair \
  --security-group-ids sg-XXXXXXXX \
  --subnet-id subnet-XXXXXXXX \
  --associate-public-ip-address \
  --iam-instance-profile Name=fleet-ec2-role \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=fleet-server-prod}]' \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]'
```

- **AMI:** Ubuntu 22.04 LTS (find the latest for your region at [cloud-images.ubuntu.com](https://cloud-images.ubuntu.com/locator/ec2/))
- **Storage:** 20 GB gp3 (faster IOPS than gp2 at same price)
- **Key pair:** Create one in the console, download `.pem`, store safely

### 1.3 Elastic IP

Allocate and associate an Elastic IP so your DNS doesn't break on instance restart:

```bash
aws ec2 allocate-address --domain vpc
aws ec2 associate-address --instance-id i-XXXX --allocation-id eipalloc-XXXX
```

### 1.4 Security Group Rules

**This is your first line of defence. Keep it minimal.**

```bash
# Create the security group
aws ec2 create-security-group \
  --group-name fleet-sg \
  --description "Fleet server production SG"

# SSH — YOUR IP ONLY (never 0.0.0.0/0)
aws ec2 authorize-security-group-ingress \
  --group-id sg-XXXX \
  --protocol tcp --port 22 \
  --cidr $(curl -s https://checkip.amazonaws.com)/32

# HTTP — Traefik redirect to HTTPS
aws ec2 authorize-security-group-ingress \
  --group-id sg-XXXX \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

# HTTPS — all traffic
aws ec2 authorize-security-group-ingress \
  --group-id sg-XXXX \
  --protocol tcp --port 443 --cidr 0.0.0.0/0

# NO other inbound rules — 3000/5432/6379 stay closed at AWS level
```

**Outbound:** Leave the default (all traffic allowed outbound). Your app needs to call Supabase, external APIs, etc.

### 1.5 IAM Role for the EC2 Instance

Create a minimal role so the instance can pull from ECR and write to CloudWatch Logs:

```json
// fleet-ec2-policy.json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": "arn:aws:ssm:*:*:parameter/fleet/*"
    }
  ]
}
```

```bash
aws iam create-policy --policy-name fleet-ec2-policy --policy-document file://fleet-ec2-policy.json
aws iam create-role --role-name fleet-ec2-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name fleet-ec2-role --policy-arn arn:aws:iam::ACCOUNT:policy/fleet-ec2-policy
aws iam create-instance-profile --instance-profile-name fleet-ec2-role
aws iam add-role-to-instance-profile --instance-profile-name fleet-ec2-role --role-name fleet-ec2-role
```

### 1.6 Store Secrets in SSM Parameter Store

Never put secrets in environment files committed to git or baked into AMIs:

```bash
aws ssm put-parameter --name /fleet/prod/DATABASE_URL --value "postgresql://..." --type SecureString
aws ssm put-parameter --name /fleet/prod/SUPABASE_JWT_SECRET --value "..." --type SecureString
aws ssm put-parameter --name /fleet/prod/REDIS_URL --value "redis://redis:6379" --type String
# etc. for every .env variable
```

---

## Part 2 — Ubuntu Server Hardening

SSH into your instance first:

```bash
ssh -i fleet-keypair.pem ubuntu@<your-elastic-ip>
```

### 2.1 System Update & Essential Packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y \
  curl wget git unzip \
  ufw fail2ban \
  ca-certificates gnupg \
  htop ncdu \
  logrotate
```

### 2.2 Create a Non-Root Deploy User

```bash
sudo adduser deploy
sudo usermod -aG sudo deploy
sudo usermod -aG docker deploy   # added after Docker install

# Copy SSH key to deploy user
sudo mkdir -p /home/deploy/.ssh
sudo cp ~/.ssh/authorized_keys /home/deploy/.ssh/
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

### 2.3 Harden SSH

```bash
sudo nano /etc/ssh/sshd_config
```

Set these values:

```
Port 22                        # consider changing to a non-standard port e.g. 2222
PermitRootLogin no             # CRITICAL
PasswordAuthentication no      # CRITICAL — key-only auth
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers deploy              # whitelist only your deploy user
```

```bash
sudo systemctl restart ssh
```

> If you change the port, update the Security Group rule and reconnect before closing your current session.

### 2.4 UFW Firewall (Host-Level, Second Layer)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp          # or your custom SSH port
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose
```

### 2.5 Fail2ban (Brute-Force Protection)

```bash
sudo nano /etc/fail2ban/jail.local
```

```ini
[DEFAULT]
bantime  = 3600          # ban for 1 hour
maxretry = 5
findtime = 600

[sshd]
enabled  = true
port     = 22
logpath  = /var/log/auth.log
maxretry = 3
bantime  = 86400         # 24h for SSH

[traefik-auth]
enabled  = true
port     = http,https
filter   = traefik-auth
logpath  = /var/log/traefik/access.log
maxretry = 10
bantime  = 3600
findtime = 300
```

Create the Traefik filter:

```bash
sudo nano /etc/fail2ban/filter.d/traefik-auth.conf
```

```ini
[Definition]
failregex = ^.*"(GET|POST|PUT|DELETE|PATCH).*" (401|403) .*$
ignoreregex =
```

```bash
sudo systemctl enable fail2ban
sudo systemctl restart fail2ban
sudo fail2ban-client status
```

### 2.6 CrowdSec (Community Bot Intelligence — Free)

CrowdSec is a modern Fail2ban replacement that uses a global threat-sharing network:

```bash
curl -s https://packagecloud.io/install/repositories/crowdsec/crowdsec/script.deb.sh | sudo bash
sudo apt install crowdsec crowdsec-firewall-bouncer-iptables -y

# Install the Traefik collection (auto-detects Traefik attack patterns)
sudo cscli collections install crowdsecurity/traefik
sudo cscli collections install crowdsecurity/linux
sudo cscli collections install crowdsecurity/sshd

sudo systemctl enable crowdsec
sudo systemctl restart crowdsec
```

CrowdSec shares banning decisions with 300k+ other servers — a bot that hit someone else gets auto-blocked on your instance.

### 2.7 Automatic Security Updates

```bash
sudo apt install unattended-upgrades -y
sudo dpkg-reconfigure --priority=low unattended-upgrades
# Select "Yes" when prompted
```

---

## Part 3 — Docker Engine Install

```bash
# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repo
echo "deb [arch=$(dpkg --print-architecture) \
  signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add users to docker group
sudo usermod -aG docker ubuntu
sudo usermod -aG docker deploy

# Enable on boot
sudo systemctl enable docker
sudo systemctl start docker

# Verify
docker --version
docker compose version
```

### Docker Daemon Security Settings

```bash
sudo nano /etc/docker/daemon.json
```

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "live-restore": true,
  "no-new-privileges": true,
  "userland-proxy": false,
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 64000,
      "Soft": 64000
    }
  }
}
```

```bash
sudo systemctl restart docker
```

---

## Part 4 — Traefik + Docker Compose Stack

### 4.1 Directory Structure on the Server

```
/opt/fleet/
├── docker-compose.yml
├── docker-compose.prod.yml
├── traefik/
│   ├── traefik.yml          # static config
│   ├── dynamic/
│   │   ├── middlewares.yml  # rate-limit, security headers, IP bans
│   │   └── tls.yml          # TLS options
│   └── acme/
│       └── acme.json        # Let's Encrypt certs (chmod 600)
├── .env                     # pulled from SSM at deploy time, never committed
└── logs/
    └── traefik/
```

```bash
sudo mkdir -p /opt/fleet/traefik/{dynamic,acme,logs}
sudo touch /opt/fleet/traefik/acme/acme.json
sudo chmod 600 /opt/fleet/traefik/acme/acme.json
sudo chown -R deploy:deploy /opt/fleet
```

### 4.2 Traefik Static Config

```yaml
# /opt/fleet/traefik/traefik.yml

global:
  checkNewVersion: false
  sendAnonymousUsage: false

log:
  level: WARN
  filePath: /logs/traefik.log

accessLog:
  filePath: /logs/access.log
  bufferingSize: 100
  fields:
    headers:
      defaultMode: drop
      names:
        User-Agent: keep
        X-Forwarded-For: keep

api:
  dashboard: false        # disable in prod; enable temporarily with IP whitelist if needed

entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true

  websecure:
    address: ":443"
    http:
      middlewares:
        - security-headers@file
        - rate-limit@file
        - crowdsec-bouncer@file
      tls:
        certResolver: letsencrypt
        options: modern@file

certificatesResolvers:
  letsencrypt:
    acme:
      email: silaselisha66@gmail.com
      storage: /acme/acme.json
      httpChallenge:
        entryPoint: web

providers:
  docker:
    exposedByDefault: false       # opt-in per container
    network: traefik_public
  file:
    directory: /dynamic
    watch: true

serversTransport:
  insecureSkipVerify: false
```

### 4.3 Traefik Dynamic Config — Middlewares & Security

```yaml
# /opt/fleet/traefik/dynamic/middlewares.yml

http:
  middlewares:

    # --- Rate limiting ---
    rate-limit:
      rateLimit:
        average: 100          # 100 req/s per IP on average
        burst: 50             # allow short bursts
        period: 1s
        sourceCriterion:
          ipStrategy:
            depth: 1

    # --- Strict rate limit for auth endpoints ---
    auth-rate-limit:
      rateLimit:
        average: 5
        burst: 10
        period: 1m

    # --- Ingest endpoint rate limit (device telemetry) ---
    ingest-rate-limit:
      rateLimit:
        average: 500
        burst: 100
        period: 1m

    # --- Security headers ---
    security-headers:
      headers:
        stsSeconds: 31536000
        stsIncludeSubdomains: true
        stsPreload: true
        forceSTSHeader: true
        contentTypeNosniff: true
        browserXssFilter: true
        referrerPolicy: strict-origin-when-cross-origin
        permissionsPolicy: "camera=(), microphone=(), geolocation=()"
        customResponseHeaders:
          X-Powered-By: ""
          Server: ""

    # --- GeoIP / IP whitelist for admin routes (optional) ---
    admin-ip-whitelist:
      ipAllowList:
        sourceRange:
          - "41.90.0.0/16"     # Kenya IP range (Safaricom example)
          - "196.201.0.0/16"   # add your office/VPN IP

    # --- Bot / crawler block ---
    block-bots:
      headers:
        customRequestHeaders:
          X-Robots-Tag: "noindex, nofollow"

    # --- CrowdSec bouncer middleware ---
    crowdsec-bouncer:
      plugin:
        crowdsec-bouncer-traefik-plugin:
          enabled: true
          crowdsecLapiKey: "${CROWDSEC_API_KEY}"
          crowdsecLapiHost: "crowdsec:8080"
          crowdsecMode: live

    # --- Compress responses ---
    compress:
      compress: {}

    # --- Strip /api/v1 prefix if needed ---
    strip-prefix:
      stripPrefix:
        prefixes:
          - "/api/v1"
```

```yaml
# /opt/fleet/traefik/dynamic/tls.yml

tls:
  options:
    modern:
      minVersion: VersionTLS12
      cipherSuites:
        - TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
        - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
        - TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305
        - TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305
      sniStrict: true
```

### 4.4 Docker Compose — Full Production Stack

```yaml
# /opt/fleet/docker-compose.yml

networks:
  traefik_public:
    external: false
    name: traefik_public
  internal:
    external: false
    name: fleet_internal

volumes:
  redis_data:
  traefik_logs:

services:

  # ── Traefik Reverse Proxy ─────────────────────────────────────────
  traefik:
    image: traefik:v3.1
    container_name: traefik
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik/traefik.yml:/traefik.yml:ro
      - ./traefik/dynamic:/dynamic:ro
      - ./traefik/acme/acme.json:/acme/acme.json
      - traefik_logs:/logs
    networks:
      - traefik_public
    environment:
      - CROWDSEC_API_KEY=${CROWDSEC_API_KEY}
    labels:
      - "traefik.enable=false"   # Traefik dashboard disabled in prod

  # ── CrowdSec ─────────────────────────────────────────────────────
  crowdsec:
    image: crowdsecurity/crowdsec:latest
    container_name: crowdsec
    restart: unless-stopped
    environment:
      PGID: "1000"
      COLLECTIONS: "crowdsecurity/traefik crowdsecurity/linux"
    volumes:
      - /var/log:/var/log:ro
      - traefik_logs:/var/log/traefik:ro
      - ./crowdsec/data:/var/lib/crowdsec/data
      - ./crowdsec/config:/etc/crowdsec
    networks:
      - internal
    security_opt:
      - no-new-privileges:true

  # ── Redis ─────────────────────────────────────────────────────────
  redis:
    image: redis:7-alpine
    container_name: fleet_redis
    restart: unless-stopped
    command: >
      redis-server
      --requirepass ${REDIS_PASSWORD}
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
      --save 60 1000
    volumes:
      - redis_data:/data
    networks:
      - internal
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "redis-cli", "--auth", "${REDIS_PASSWORD}", "ping"]
      interval: 30s
      timeout: 5s
      retries: 3

  # ── Fleet API ─────────────────────────────────────────────────────
  fleet_api:
    image: ${ECR_REGISTRY}/fleet-server:${IMAGE_TAG:-latest}
    container_name: fleet_api
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: ${DATABASE_URL}
      DIRECT_URL: ${DIRECT_URL}
      SUPABASE_URL: ${SUPABASE_URL}
      SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY}
      SUPABASE_JWT_SECRET: ${SUPABASE_JWT_SECRET}
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
      CORS_ORIGIN: ${CORS_ORIGIN}
    networks:
      - traefik_public
      - internal
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=traefik_public"

      # --- Main API router ---
      - "traefik.http.routers.fleet-api.rule=Host(`api.yourdomain.com`)"
      - "traefik.http.routers.fleet-api.entrypoints=websecure"
      - "traefik.http.routers.fleet-api.tls.certresolver=letsencrypt"
      - "traefik.http.routers.fleet-api.middlewares=rate-limit@file,security-headers@file,compress@file"
      - "traefik.http.services.fleet-api.loadbalancer.server.port=3000"
      - "traefik.http.services.fleet-api.loadbalancer.healthcheck.path=/health"
      - "traefik.http.services.fleet-api.loadbalancer.healthcheck.interval=30s"

      # --- Auth routes — stricter rate limit ---
      - "traefik.http.routers.fleet-auth.rule=Host(`api.yourdomain.com`) && PathPrefix(`/api/v1/auth`)"
      - "traefik.http.routers.fleet-auth.entrypoints=websecure"
      - "traefik.http.routers.fleet-auth.tls.certresolver=letsencrypt"
      - "traefik.http.routers.fleet-auth.middlewares=auth-rate-limit@file,security-headers@file"
      - "traefik.http.routers.fleet-auth.priority=10"

      # --- Ingest endpoint — high throughput rate limit ---
      - "traefik.http.routers.fleet-ingest.rule=Host(`api.yourdomain.com`) && PathPrefix(`/api/v1/ingest`)"
      - "traefik.http.routers.fleet-ingest.entrypoints=websecure"
      - "traefik.http.routers.fleet-ingest.tls.certresolver=letsencrypt"
      - "traefik.http.routers.fleet-ingest.middlewares=ingest-rate-limit@file"
      - "traefik.http.routers.fleet-ingest.priority=20"

    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
    deploy:
      resources:
        limits:
          cpus: "1.5"
          memory: 512M
        reservations:
          memory: 128M
```

---

## Part 5 — ECR (Container Registry)

```bash
# Create ECR repo
aws ecr create-repository \
  --repository-name fleet-server \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256

# Add lifecycle policy (keep last 10 images)
aws ecr put-lifecycle-policy \
  --repository-name fleet-server \
  --lifecycle-policy-text '{
    "rules": [{
      "rulePriority": 1,
      "description": "Keep last 10 images",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": {"type": "expire"}
    }]
  }'
```

---

## Part 6 — GitHub Actions CI/CD Pipeline

### 6.1 Repository Secrets to Configure

Go to your GitHub repo → Settings → Secrets and variables → Actions → New repository secret:

```
AWS_ACCESS_KEY_ID          # IAM user with ECR push + SSM read permissions
AWS_SECRET_ACCESS_KEY
AWS_REGION                 # e.g. af-south-1 (Cape Town) or eu-west-1
ECR_REGISTRY               # ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com
ECR_REPOSITORY             # fleet-server
EC2_HOST                   # your Elastic IP
EC2_USER                   # deploy
EC2_SSH_KEY                # contents of fleet-keypair.pem
CROWDSEC_API_KEY
```

### 6.2 The Pipeline

```yaml
# .github/workflows/deploy.yml

name: CI/CD — Build, Test, Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  NODE_VERSION: "22"
  IMAGE_TAG: ${{ github.sha }}

jobs:
  # ── 1. Test ──────────────────────────────────────────────────────
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm

      - run: npm ci

      - name: Type check
        run: npx tsc --noEmit

      - name: Run tests
        run: npx vitest run --coverage

      - name: Upload coverage
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: coverage/

  # ── 2. Build & Push Image ────────────────────────────────────────
  build:
    name: Build Docker Image
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    outputs:
      image: ${{ steps.build.outputs.image }}

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ secrets.AWS_REGION }}

      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push image
        id: build
        env:
          REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          REPOSITORY: ${{ secrets.ECR_REPOSITORY }}
        run: |
          docker build \
            --target runner \
            --cache-from $REGISTRY/$REPOSITORY:latest \
            --build-arg BUILDKIT_INLINE_CACHE=1 \
            -t $REGISTRY/$REPOSITORY:${{ env.IMAGE_TAG }} \
            -t $REGISTRY/$REPOSITORY:latest \
            .
          docker push $REGISTRY/$REPOSITORY:${{ env.IMAGE_TAG }}
          docker push $REGISTRY/$REPOSITORY:latest
          echo "image=$REGISTRY/$REPOSITORY:${{ env.IMAGE_TAG }}" >> $GITHUB_OUTPUT

      - name: Scan image for vulnerabilities
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ steps.build.outputs.image }}
          format: table
          exit-code: 1           # fail build on CRITICAL CVEs
          severity: CRITICAL

  # ── 3. Deploy to EC2 ────────────────────────────────────────────
  deploy:
    name: Deploy to Production
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production     # requires manual approval in GitHub (optional)

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ secrets.AWS_REGION }}

      - name: Pull SSM secrets and deploy
        uses: appleboy/ssh-action@v1.0.3
        env:
          ECR_REGISTRY: ${{ secrets.ECR_REGISTRY }}
          ECR_REPOSITORY: ${{ secrets.ECR_REPOSITORY }}
          IMAGE_TAG: ${{ env.IMAGE_TAG }}
          AWS_REGION: ${{ secrets.AWS_REGION }}
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ${{ secrets.EC2_USER }}
          key: ${{ secrets.EC2_SSH_KEY }}
          envs: ECR_REGISTRY,ECR_REPOSITORY,IMAGE_TAG,AWS_REGION
          script: |
            set -e

            # Pull secrets from SSM into .env
            cd /opt/fleet
            aws ssm get-parameters-by-path \
              --path /fleet/prod \
              --with-decryption \
              --query "Parameters[*].[Name,Value]" \
              --output text | \
              awk '{gsub("/fleet/prod/","",$1); print $1"="$2}' > .env
            chmod 600 .env

            # Auth with ECR
            aws ecr get-login-password --region $AWS_REGION | \
              docker login --username AWS --password-stdin $ECR_REGISTRY

            # Export for compose
            export IMAGE_TAG=$IMAGE_TAG
            export ECR_REGISTRY=$ECR_REGISTRY

            # Pull new image
            docker pull $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG

            # Rolling update — zero-downtime
            docker compose pull fleet_api
            docker compose up -d --no-deps --wait fleet_api

            # Clean up old images
            docker image prune -f

            echo "Deploy complete: $IMAGE_TAG"

      - name: Verify deployment
        run: |
          sleep 10
          STATUS=$(curl -sf https://api.yourdomain.com/health | jq -r '.status')
          if [ "$STATUS" != "success" ]; then
            echo "Health check failed!"
            exit 1
          fi
          echo "Health check passed: $STATUS"
```

### 6.3 IAM User for GitHub Actions (Least Privilege)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## Part 7 — Scaling Strategy

### Vertical Scaling (Simple)

Stop instance → change type → start. With gp3 EBS and Elastic IP this takes ~3 minutes:

```
t3.small (2 GB)  →  t3.medium (4 GB)  →  t3.large (8 GB)
```

### Horizontal Scaling (Docker Compose → ECS or multiple EC2s)

When you outgrow one instance:

1. **Session state** — already using Redis (shared between instances)
2. **Add an Application Load Balancer (ALB)** in front of two EC2 instances
3. **Create an AMI** from your configured instance — new instances start pre-configured
4. **Auto Scaling Group** with target tracking (scale at 70% CPU)

```bash
# Create AMI from running instance
aws ec2 create-image \
  --instance-id i-XXXX \
  --name "fleet-server-base-$(date +%Y%m%d)" \
  --no-reboot
```

### Future: ECS Fargate (Serverless Containers)

When managing EC2 instances becomes overhead, migrate to ECS Fargate:
- Same Docker images, same ECR registry
- No servers to patch
- Auto-scales to zero at night
- GitHub Actions pipeline changes by ~10 lines

---

## Part 8 — Monitoring & Alerts

### CloudWatch (Free Tier Friendly)

```bash
# Install CloudWatch agent on the instance
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
sudo dpkg -i amazon-cloudwatch-agent.deb

# Configure to ship Docker logs + system metrics
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
```

Set CloudWatch alarms:

```bash
# Alert if CPU > 80% for 5 minutes
aws cloudwatch put-metric-alarm \
  --alarm-name fleet-high-cpu \
  --metric-name CPUUtilization \
  --namespace AWS/EC2 \
  --statistic Average \
  --period 300 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:REGION:ACCOUNT:fleet-alerts

# Alert if instance health check fails
aws cloudwatch put-metric-alarm \
  --alarm-name fleet-status-check \
  --metric-name StatusCheckFailed \
  --namespace AWS/EC2 \
  --statistic Maximum \
  --period 60 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:REGION:ACCOUNT:fleet-alerts
```

---

## Part 9 — Maintenance Runbook

### Deploy a new version manually

```bash
ssh deploy@<your-ip>
cd /opt/fleet
docker compose pull fleet_api
docker compose up -d --no-deps --wait fleet_api
docker image prune -f
```

### View logs

```bash
# App logs
docker compose logs fleet_api -f --tail 100

# Traefik access log
tail -f /opt/fleet/traefik/logs/access.log

# Fail2ban status
sudo fail2ban-client status sshd

# CrowdSec decisions
sudo cscli decisions list
```

### Roll back to a previous image

```bash
IMAGE_TAG=<previous-sha> docker compose up -d --no-deps fleet_api
```

### Update Traefik middleware (zero-downtime)

Edit any file in `/opt/fleet/traefik/dynamic/` — Traefik hot-reloads within 1–2 seconds. No restart needed.

---

## Quick-Start Checklist

```
AWS Setup
  [ ] EC2 t3.small launched, Ubuntu 22.04 LTS
  [ ] Elastic IP attached
  [ ] Security Group: 22 (your IP), 80, 443 only
  [ ] IAM role attached to instance (ECR + SSM + CloudWatch)
  [ ] ECR repository created
  [ ] Secrets added to SSM Parameter Store
  [ ] GitHub Actions secrets configured

Server Hardening
  [ ] System updated
  [ ] deploy user created, SSH key installed
  [ ] Root SSH disabled, password auth disabled
  [ ] UFW enabled (22/80/443)
  [ ] Fail2ban enabled and configured
  [ ] CrowdSec installed with Traefik + Linux collections
  [ ] Unattended upgrades enabled

Docker & Traefik
  [ ] Docker Engine + Compose plugin installed
  [ ] /opt/fleet directory structure created
  [ ] acme.json created with chmod 600
  [ ] traefik.yml, middlewares.yml, tls.yml written
  [ ] docker-compose.yml written
  [ ] docker compose up -d runs cleanly
  [ ] HTTPS working at api.yourdomain.com/health

CI/CD
  [ ] .github/workflows/deploy.yml committed
  [ ] Push to main triggers test → build → deploy
  [ ] Health check step passes after deploy
```
