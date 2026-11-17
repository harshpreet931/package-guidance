# Ruff: replaces flake8 + isort + black (+ pyupgrade)
Applies to: flake8 (+ plugins), black, isort, pyupgrade, autoflake in new or consolidating projects   ·   Last verified: 2026-11-16   ·   Source: https://docs.astral.sh/ruff/

Ruff (0.17.x) is one Rust binary with "drop-in parity with Flake8, isort, and Black" and pyupgrade-style rules. flake8, black and isort are still maintained, so **this is a preference, not a fix**. Do not churn a working setup without being asked. Use Ruff for new projects.

## Use instead
- `ruff check` for linting (Flake8, pyflakes, pycodestyle, isort via `I`, pyupgrade via `UP`, bugbear via `B`, and more).
- `ruff format` for formatting (Black-compatible output).

## Setup (current, copy-pasteable)
```bash
uv add --dev ruff            # or: pip install ruff / uvx ruff
ruff check --fix .
ruff format .
```
```toml
# pyproject.toml
[tool.ruff]
line-length = 88
target-version = "py312"

[tool.ruff.lint]
select = ["E4", "E7", "E9", "F", "I", "UP", "B"]

[tool.ruff.format]
quote-style = "double"
```
pre-commit:
```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.17.5
    hooks:
      - id: ruff-check
        args: [--fix]
      - id: ruff-format
```

## DO
- Run `ruff check --fix` **before** `ruff format`. Import sorting (`I`) is a lint fix, not part of the formatter.
- Put all config under `[tool.ruff]` / `[tool.ruff.lint]` / `[tool.ruff.format]` (or `ruff.toml`).
- Pin the Ruff version (lockfile or pre-commit `rev`). New releases add rules and can change results.

## DO NOT
- Do not run Black and `ruff format` (or isort and Ruff's `I` rules) together. They fight.
- Do not put lint settings like `select` at the top level of `[tool.ruff]`. They belong in `[tool.ruff.lint]`.
- Do not use the legacy pre-commit hook id `ruff`. Use `ruff-check`.

## Migrating existing code
1. Add Ruff and translate settings:
   - flake8 `max-line-length` becomes `line-length`; `extend-ignore` becomes `[tool.ruff.lint] ignore`; `per-file-ignores` becomes `[tool.ruff.lint.per-file-ignores]`.
   - flake8 plugins map to rule prefixes: bugbear `B`, comprehensions `C4`, simplify `SIM`, pep8-naming `N`, docstrings `D`.
   - isort `profile = "black"` is already the Ruff default. `known_first_party` becomes `[tool.ruff.lint.isort] known-first-party`.
2. Run `ruff check --fix . && ruff format .` once and commit the result as a single "format" commit (add it to `.git-blame-ignore-revs`).
3. Remove `flake8`, `black`, `isort`, `pyupgrade`, `autoflake`, their config (`.flake8`, `[tool.black]`, `[tool.isort]`, `setup.cfg [flake8]`) and their pre-commit hooks.
