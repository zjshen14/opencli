# Security Policy

## Supported Versions

OpenCLI is under active development. Security updates are generally provided for the latest minor version. We recommend that all users stay on the latest version of the CLI.

| Version | Supported          |
| ------- | ------------------ |
| v0.1.x  | :white_check_mark: |
| < v0.1  | :x:                |

## Reporting a Vulnerability

Security is a top priority for OpenCLI, especially given its ability to execute system commands via LLM tools. If you discover a security vulnerability in OpenCLI, we appreciate your help in disclosing it to us in a responsible manner.

**Do NOT report security vulnerabilities through public GitHub issues.**

Instead, please report them via the **GitHub Security Advisories** feature for this repository:
1. Go to the [Security tab](https://github.com/zjshen14/opencli/security/advisories) on the repository.
2. Click "Report a vulnerability".
3. Provide a detailed description of the issue, including steps to reproduce.

### Response Timeline
We will acknowledge your report within 48 hours and provide an estimated timeline for resolution. We aim to fix critical vulnerabilities as quickly as possible and will publish a security advisory once the fix is released.

## Security Best Practices
- OpenCLI defaults to running in a **sandboxed** environment (`sandbox-exec` on macOS, `bwrap` on Linux) to prevent unauthorized filesystem access.
- Always review the planned tool executions before proceeding.
- Do not run the CLI with elevated privileges (`sudo` or as `root`) unless absolutely necessary.
