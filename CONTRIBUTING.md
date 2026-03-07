# Contributing to MCP Database Server

Thank you for your interest in contributing! This document provides guidelines for contributing to this project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/database-mcp-server.git`
3. Install dependencies: `npm install`
4. Create a feature branch: `git checkout -b feature/your-feature`

## Development

### Building

```bash
npm run build
```

### Running Tests

```bash
npm test
npm run test:watch  # Watch mode
```

### Code Style

- TypeScript strict mode is enabled
- Use meaningful variable and function names
- Add JSDoc comments for public functions
- Follow existing code patterns

## Pull Request Process

1. Ensure all tests pass: `npm test`
2. Ensure the build succeeds: `npm run build`
3. Update documentation if your change affects the public API
4. Write a clear PR description explaining the change and motivation
5. Link any related issues

## Reporting Issues

- Use GitHub Issues to report bugs
- Include steps to reproduce, expected behavior, and actual behavior
- Include your Node.js version and database type/version

## Security

If you discover a security vulnerability, please report it responsibly. Do **not** open a public issue. Instead, email security@nucleusenterprise.ai with details.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
