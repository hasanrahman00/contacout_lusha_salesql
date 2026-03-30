#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# VikiLeads — Build & Push to Docker Hub
# ═══════════════════════════════════════════════════════════════════
#
#   chmod +x build.sh
#   ./build.sh
# ═══════════════════════════════════════════════════════════════════

set -e

REGISTRY="hasandocker4"
IMAGE="vikileads"
TAG="3.6.0"
FULL="${REGISTRY}/${IMAGE}:${TAG}"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   VikiLeads Docker Build & Push          ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# Step 1: Build
echo "🔨 Building ${FULL} (obfuscating source code)..."
docker build -t ${FULL} .
echo "✅ Image built"

# Step 2: Login
echo ""
echo "🔑 Logging into Docker Hub..."
docker login -u ${REGISTRY}

# Step 3: Push
echo ""
echo "📤 Pushing to Docker Hub..."
docker push ${FULL}
echo "✅ Pushed: ${FULL}"

# Step 4: Create delivery folder
echo ""
echo "📁 Creating delivery/ folder..."
rm -rf delivery && mkdir delivery
cp docker-compose.yml delivery/
cp CLIENT_README.md delivery/README.md

cat > delivery/.env << 'EOF'
# DeepSeek API key for domain validation (optional, leave empty to skip)
DEEPSEEK_API_KEY=
EOF

echo ""
echo "  ✅ Done!"
echo ""
echo "  Image live at: https://hub.docker.com/r/${REGISTRY}/${IMAGE}"
echo ""
echo "  Send delivery/ to client:"
echo "  delivery/"
echo "  ├── docker-compose.yml"
echo "  ├── .env"
echo "  └── README.md"
echo ""
echo "  No tar.gz needed — client just runs: docker compose up -d"
echo ""