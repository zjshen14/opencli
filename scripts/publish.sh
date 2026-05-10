#!/bin/bash
set -e

echo "📦 Preparing to publish @zjshen/opencli..."

# Ensure we are logged in
if ! npm whoami > /dev/null 2>&1; then
  echo "❌ You are not logged into NPM. Please run 'npm login' first."
  exit 1
fi

# Extract version from package.json
VERSION=$(node -p "require('./package.json').version")

# Step 1: Install dependencies and build
echo "🔨 Building the project..."
npm install
npm run build

# Step 2: Publish to NPM
echo "🚀 Publishing to NPM registry..."
npm publish --access public

# Step 3: Sync with GitHub Releases
echo "🐙 Creating GitHub Release v$VERSION..."
if ! gh release view "v$VERSION" > /dev/null 2>&1; then
  gh release create "v$VERSION" --title "v$VERSION" --generate-notes
  echo "✅ GitHub Release v$VERSION created."
else
  echo "⚠️  GitHub Release v$VERSION already exists, skipping."
fi

echo "✅ Successfully published! You can now install it globally using:"
echo "   npm install -g @zjshen/opencli"
