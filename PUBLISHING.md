# Publishing & Installing `opencli`

This document outlines the standard workflow for releasing new versions of `opencli` and installing it on any machine.

## How to Publish a New Version

Whenever you make code changes and want to release an update, follow these steps:

1. **Bump the Version Number**
   Update the `"version"` field in `package.json` (e.g., from `"0.1.1"` to `"0.1.2"`). 
   *Note: NPM does not allow you to publish the same version number twice.*

2. **Run the Publish Script**
   Execute the automated publish script from the terminal:
   ```bash
   npm run release
   ```
   This script will automatically:
   - Check your NPM authentication
   - Run `npm run build` to ensure the `dist` folder is up to date
   - Run `npm publish --access public`
   - Prompt you for your Authenticator App 2FA code.

## How to Install and Run `opencli`

Because `opencli` is published as a public NPM package, anyone can install and run it as long as they have Node.js installed on their computer.

### Option 1: Install Globally (Recommended)
This installs the tool permanently on your machine so you can run it from any directory.

```bash
# Install it globally
npm install -g @zjshen/opencli

# Run the tool
opencli
```

### Option 2: Run Without Installing (`npx`)
If you want to run the tool without permanently installing it, you can use `npx`. This will fetch the latest version from NPM and execute it immediately.

```bash
npx @zjshen/opencli
```

## Troubleshooting

- **403 Forbidden Error**: Ensure you have [Two-Factor Authentication (2FA) enabled](https://docs.npmjs.com/configuring-two-factor-authentication) on your NPM account.
- **Command Not Found**: Ensure that your NPM global bin directory is in your system's `PATH`.
