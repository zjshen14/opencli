#!/bin/bash
set -e

echo "📦 Preparing to publish @zjshen/opencli..."

# Ensure we are logged in
if ! npm whoami > /dev/null 2>&1; then
  echo "❌ You are not logged into NPM. Please run 'npm login' first."
  exit 1
fi

# Step 1: Install dependencies and build
echo "🔨 Building the project..."
npm install
npm run build

# Step 2: Publish to NPM
echo "🚀 Publishing to NPM registry..."
npm publish --access public

echo "✅ Successfully published! You can now install it globally using:"
echo "   npm install -g @zjshen/opencli"
