# uv: one tool for Python projects, envs, tools and Python itself
Applies to: pip + venv + requirements.txt, pip-tools, pipenv, virtualenv, setup.py-only projects, poetry (optional)   ·   Last verified: 2026-11-16   ·   Source: https://docs.astral.sh/uv/

uv (0.13.x) replaces pip, pip-tools, virtualenv, pipenv and pyenv for most projects: a `pyproject.toml` project, a cross-platform `uv.lock`, managed Python versions, and a built-in release-age cooldown (`exclude-newer`). Poetry 2.x is still maintained, so keep it where a team relies on it.

## Use instead
- New project: `uv init`, then `uv add`.
- Scripts and one-off tools: `uv run`, `uvx <tool>` (= `uv tool run`).
- Legacy flows that must stay pip-shaped: `uv pip install`, `uv pip compile` (drop-in, faster).

## Setup (current, copy-pasteable)
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh        # or: brew install uv / pipx install uv
uv init my-app && cd my-app
uv python pin 3.13
uv add httpx pydantic
uv add --dev pytest ruff
uv run pytest
```
Cooldown (uv >= 0.9.17):
```toml
# pyproject.toml
[tool.uv]
exclude-newer = "7 days"
# exempt an internal package from the cooldown:
exclude-newer-package = { my-internal-lib = false }
```
CI:
```bash
uv sync --locked          # fail if uv.lock is out of date
uv run pytest
```

## DO
- Commit `uv.lock` and `.python-version`.
- Declare dependencies in `[project].dependencies` and dev tools in `[dependency-groups].dev` (what `uv add --dev` writes).
- Use `uv run` instead of activating venvs by hand. It syncs `.venv` automatically.
- Use inline script metadata for single files: `uv add --script tool.py requests`, then `uv run tool.py`.

## DO NOT
- Do not write new `setup.py` / `setup.cfg`-only projects. Use `pyproject.toml` (`uv init --lib` for libraries).
- Do not `pip install` into the system Python or mix `pip install` into a uv-managed `.venv`. Use `uv add` / `uv pip`.
- Do not hand-edit `uv.lock`.
- Do not remove or shorten a configured `exclude-newer`. Use `exclude-newer-package` for a reviewed exception.

## Migrating existing code
- **requirements.txt**: `uv init --bare` (keeps your layout), then `uv add -r requirements.txt` and `uv add --dev -r requirements-dev.txt`. If something downstream still needs a requirements file, generate it with `uv export --format requirements.txt -o requirements.txt`.
- **pip-tools**: `pip-compile` becomes `uv pip compile requirements.in -o requirements.txt`, and `pip-sync` becomes `uv pip sync requirements.txt`. Or move fully to `uv add`.
- **Poetry / Pipenv**: `uvx migrate-to-uv` converts `pyproject.toml` / `Pipfile` metadata and dependency groups. Review the result, then `uv lock`.
- **setup.py**: move metadata into `[project]` in `pyproject.toml` with a build backend (`uv init --lib` shows the template). Keep `setup.py` only for custom C-extension build logic.
- **pyenv**: `uv python install 3.13` and `uv python pin 3.13`.
- **pipx**: `uv tool install ruff`, or `uvx ruff check`.
