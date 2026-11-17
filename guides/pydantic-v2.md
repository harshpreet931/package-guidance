# Pydantic v1 → v2
Applies to: pydantic <2, v1-style code on v2 (`.dict()`, `@validator`, `class Config`)   ·   Last verified: 2026-11-16   ·   Source: https://pydantic.dev/docs/validation/latest/get-started/migration/

Pydantic v2 (2.14.x, Python >= 3.10) is current. Agents still emit v1 idioms. They raise deprecation warnings at best and break at worst. Write v2 APIs only.

## Use instead
- `pydantic>=2` for models.
- `pydantic-settings` for `BaseSettings` (it moved out of `pydantic`).
- `bump-pydantic` (beta) to rewrite existing code.

## Setup (current, copy-pasteable)
```bash
uv add pydantic pydantic-settings      # or: pip install pydantic pydantic-settings
```
```python
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

class User(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)

    id: int
    email: str
    nickname: str | None = None          # optional AND defaulted
    tags: list[str] = Field(default_factory=list)

    @field_validator("email")
    @classmethod
    def lower_email(cls, v: str) -> str:
        return v.lower()

    @model_validator(mode="after")
    def check(self) -> "User":
        return self

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="APP_")
    database_url: str

user = User.model_validate({"id": 1, "email": "A@B.CO"})
user.model_dump(); user.model_dump_json(); User.model_json_schema()
```

## DO
- `model_config = ConfigDict(...)` instead of an inner `class Config`.
- `@field_validator` / `@model_validator` (always add `@classmethod` to field validators).
- Give `X | None` fields an explicit `= None` if they are meant to be optional. In v2, `Optional[T]` without a default is **required**.
- Use `RootModel[list[Item]]` instead of `__root__`.
- Use `TypeAdapter(list[Item]).validate_python(data)` for validating non-model types.

## DO NOT
- Do not pin `pydantic<2` or `pydantic==1.*` in new code.
- Do not import `BaseSettings` from `pydantic`.
- Do not use `orm_mode`, `allow_population_by_field_name`, `.dict()`, `.json()`, `.parse_obj()`, `.parse_raw()`, `.copy()`, `.construct()`, `.update_forward_refs()`, `@validator` or `@root_validator`.
- Do not leave `from pydantic.v1 import ...` as the permanent solution. It is a migration shim.

## Migrating existing code
1. Run `uvx bump-pydantic my_package` (or `pip install bump-pydantic && bump-pydantic my_package`) and review the diff.
2. Rename the APIs:

| v1 | v2 |
|---|---|
| `.dict()` / `.json()` | `.model_dump()` / `.model_dump_json()` |
| `Model.parse_obj(d)` / `.parse_raw(s)` | `Model.model_validate(d)` / `.model_validate_json(s)` |
| `.copy(update=…)` | `.model_copy(update=…)` |
| `.construct()` | `.model_construct()` |
| `.schema()` / `.schema_json()` | `.model_json_schema()` |
| `.update_forward_refs()` | `.model_rebuild()` |
| `@validator` / `@root_validator` | `@field_validator` / `@model_validator` |
| `class Config: orm_mode = True` | `model_config = ConfigDict(from_attributes=True)` |
| `from_orm(obj)` | `model_validate(obj)` with `from_attributes=True` |
| `__root__: list[int]` | `class M(RootModel[list[int]])` |

3. Re-run tests with warnings as errors (`-W error::DeprecationWarning`) to catch leftover v1 calls.
4. For FastAPI, upgrade FastAPI too. Current FastAPI requires Pydantic v2.
