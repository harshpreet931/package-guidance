# OpenAI SDKs: Python 0.x → current, Node v3 → current
Applies to: openai (PyPI) <1, openai (npm) <4   ·   Last verified: 2026-11-16   ·   Source: https://github.com/openai/openai-python/discussions/742

Models trained on 2023 code still emit `openai.ChatCompletion.create(...)` (Python 0.x) and `new OpenAIApi(new Configuration(...))` (Node v3). Both were removed years ago. Current majors: **Python `openai` 3.x** (Python >= 3.10) and **npm `openai` 7.x** (Node >= 22).

## Use instead
- An explicit client: `OpenAI()` / `AsyncOpenAI()` in Python, `new OpenAI()` in JS. Both read `OPENAI_API_KEY` from the environment.
- `client.responses.create(...)` for new work, or `client.chat.completions.create(...)`.
- Pick the model id from OpenAI's current model docs. Do not reuse a model name from memory.

## Setup (current, copy-pasteable)
Python:
```bash
uv add openai          # or: pip install openai
```
```python
from openai import OpenAI

client = OpenAI()
resp = client.responses.create(model=MODEL, input="Say hello")
print(resp.output_text)

chat = client.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": "Hi"}])
print(chat.choices[0].message.content)
```
Node / TypeScript:
```bash
npm install openai
```
```ts
import OpenAI from "openai";

const client = new OpenAI();
const resp = await client.responses.create({ model: MODEL, input: "Say hello" });
console.log(resp.output_text);
```

## DO
- Use `AsyncOpenAI` for asyncio, and stream with `stream=True` / `{ stream: true }` (iterate the result).
- Catch typed errors: `openai.APIError`, `openai.RateLimitError`, `openai.BadRequestError`.
- Responses are typed objects. In Python, call `.model_dump()` to get a dict.

## DO NOT
- Python: do not use `openai.ChatCompletion`, `openai.Completion`, `openai.Embedding`, `openai.api_key = ...`, `openai.api_base` or `acreate`. All were removed in 1.0 (Nov 2023).
- Node: do not import `Configuration` / `OpenAIApi` or call `createChatCompletion`, and do not read `response.data.choices`.
- Do not install `openai@3` (npm) or `openai<1` (PyPI).
- Python 3.x: do not pass an `httpx.Client` as `http_client`. 3.0 (2026-08-12) switched to **HTTPX2** and no longer installs `httpx` (see `httpx2.md` in the repo).

## Migrating existing code
Python 0.x → current (the `openai migrate` command, grit-based, automates most of this; commit first):

| 0.x | current |
|---|---|
| `openai.api_key = k` | `client = OpenAI(api_key=k)` (or env var) |
| `openai.ChatCompletion.create(...)` | `client.chat.completions.create(...)` |
| `openai.Completion.create(...)` | `client.completions.create(...)` |
| `openai.Embedding.create(...)` | `client.embeddings.create(...)` |
| `openai.Image.create(...)` | `client.images.generate(...)` |
| `openai.ChatCompletion.acreate(...)` | `await AsyncOpenAI().chat.completions.create(...)` |
| `resp["choices"][0]["message"]` | `resp.choices[0].message` |
| `openai.InvalidRequestError` | `openai.BadRequestError` |
| `openai.api_base` | `OpenAI(base_url=...)` |
| Azure via `api_type` | `AzureOpenAI(...)` |

Node v3 → current:

| v3 | current |
|---|---|
| `new OpenAIApi(new Configuration({ apiKey }))` | `new OpenAI({ apiKey })` |
| `openai.createChatCompletion({...})` | `client.chat.completions.create({...})` |
| `res.data.choices[0]` | `res.choices[0]` |
| axios-based errors | `OpenAI.APIError` subclasses |

Later Node majors: v5 uses built-in fetch with zero deps, and `withResponse()` / `asResponse()` return Web `Response` / `ReadableStream`. Methods with several path params take named params (`retrieve(childId, { parent_id })`). v7 requires Node 22. See https://github.com/openai/openai-node/blob/master/MIGRATION.md.
