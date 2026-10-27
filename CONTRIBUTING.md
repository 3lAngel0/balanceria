# Contributing to ai-balancer

Thank you for contributing to `ai-balancer`. We welcome bug reports, documentation improvements, and targeted pull requests.

---

## Development Setup

- **Node.js**: Requires Node.js `>= 22.19.0`.
- **Package Manager**: Use `npm`.

### Running Tests

Run the full test suite using Node's built-in test runner:

```bash
npm test
```

Under the hood, this executes:

```bash
AI_BALANCER_LANG=en node --test tests/*.test.ts packages/panel/tests/*.test.ts
```

Tests run with fixed environment language (`AI_BALANCER_LANG=en`) to guarantee deterministic validation across systems. Ensure all tests pass before submitting changes.

---

## Contribution Guidelines

1. **Keep Pull Requests Scoped**:
   - Prefer small, focused PRs (under 400 lines of changes).
   - Keep tests and documentation updates in the same PR as the code they cover.
2. **Technical Artifacts in English**:
   - All source code, identifiers, function and variable names, comments, commit messages, and PR descriptions must be written in English.
   - User-facing documentation is maintained with English as canonical (`README.md`, `docs/guide.md`) and Spanish mirrors (`README.es.md`, `docs/guide.es.md`) in neutral professional Spanish.
3. **Conventional Commits**:
   - Use standard conventional commit messages: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `chore:`.
   - Do not add "Co-Authored-By" or AI attribution trailers to commit messages.
4. **No Hardcoded Absolute Paths**:
   - Never commit absolute local paths (e.g., `/home/...`), personal email addresses, or API keys. Always use relative paths or `<path-to-repo>`.
5. **Deterministic Behavior**:
   - The router is strictly deterministic. Do not introduce LLM calls, network I/O, or asynchronous polling into the request routing pipeline.
