"""Self-hosted browser-use sidecar for the company-brain browse_website tool.

The worker cannot run Chromium, so it POSTs { task, start_url } here and this
service drives headless Chromium with YOUR LLM key (no Browser-Use Cloud).

Run:  pip install -r requirements.txt && uvicorn main:app --port 8000
Env:  see .env.example
"""

import asyncio
import hmac
import os
import time

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, HttpUrl

# Worker parity: the turn tool clips to 12k chars, so a longer transcript only
# burns sidecar tokens waiting for a cap the worker applies anyway.
RESULT_BUDGET = 12_000
DEFAULT_MAX_SECONDS = 240


class RunRequest(BaseModel):
    task: str = Field(min_length=5, max_length=2000)
    start_url: HttpUrl


class RunResponse(BaseModel):
    ok: bool = True
    result: str
    steps: int
    ms: int


def expected_token() -> str:
    token = os.environ.get("BROWSER_SERVICE_TOKEN", "").strip()
    if not token:
        raise RuntimeError("BROWSER_SERVICE_TOKEN is not set")
    return token


bearer = HTTPBearer(auto_error=False)
# One browser, one job: held for the whole agent run so a second caller gets
# 429 now instead of queueing silently behind a minutes-long job.
run_lock = asyncio.Lock()

app = FastAPI(title="company-brain browser sidecar")


async def require_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> None:
    presented = (credentials.credentials if credentials else "").strip()
    if not presented or not hmac.compare_digest(presented, expected_token()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)


def make_llm():
    """First configured provider wins; BROWSER_LLM forces one explicitly."""
    preference = os.environ.get("BROWSER_LLM", "").strip().lower()
    has = lambda name: bool(os.environ.get(name, "").strip())  # noqa: E731
    order = ["openai", "anthropic", "google", "chat-browser-use"]
    if preference:
        if preference not in order:
            raise RuntimeError(f"Unknown BROWSER_LLM={preference!r}")
        order = [preference]
    for provider in order:
        if provider == "openai" and (has("OPENAI_API_KEY") or preference):
            from browser_use import ChatOpenAI

            return ChatOpenAI(model="gpt-4.1-mini")
        if provider == "anthropic" and (has("ANTHROPIC_API_KEY") or preference):
            from browser_use import ChatAnthropic

            return ChatAnthropic(model="claude-sonnet-4-0", temperature=0.0)
        if provider == "google" and (has("GOOGLE_API_KEY") or preference):
            from browser_use import ChatGoogle

            return ChatGoogle(model="gemini-flash-latest")
        if provider == "chat-browser-use" and (
            has("BROWSER_USE_API_KEY") or preference
        ):
            from browser_use import ChatBrowserUse

            return ChatBrowserUse()
    raise RuntimeError(
        "No LLM key set: provide OPENAI_API_KEY, ANTHROPIC_API_KEY, "
        "GOOGLE_API_KEY, or BROWSER_USE_API_KEY (see BROWSER_LLM to pick)."
    )


async def run_agent(task: str, start_url: str, max_seconds: int) -> tuple[str, int]:
    from browser_use import Agent, Browser

    headless = os.environ.get("BROWSER_HEADLESS", "true").strip().lower() != "false"
    browser = Browser(headless=headless)
    agent = Agent(
        task=f"Start at {start_url} and complete this goal: {task}",
        llm=make_llm(),
        browser=browser,
    )
    try:
        history = await asyncio.wait_for(agent.run(), timeout=max_seconds)
        final = (history.final_result() or "").strip()
        steps = len(history.history or [])
        return final[:RESULT_BUDGET], steps
    finally:
        await browser.close()


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "busy": run_lock.locked()}


@app.post("/run", response_model=RunResponse, dependencies=[Depends(require_token)])
async def run(body: RunRequest, request: Request) -> JSONResponse:
    if run_lock.locked():
        return JSONResponse({"detail": "browser is busy"}, status_code=429)
    async with run_lock:
        started = time.monotonic()
        max_seconds = int(os.environ.get("BROWSER_MAX_SECONDS", DEFAULT_MAX_SECONDS))
        try:
            result, steps = await run_agent(
                body.task.strip(), str(body.start_url), max_seconds
            )
        except asyncio.TimeoutError:
            return JSONResponse(
                {"detail": "browser task timed out"}, status_code=504
            )
        ms = int((time.monotonic() - started) * 1000)
        if not result:
            return JSONResponse(
                {
                    "ok": False,
                    "result": "",
                    "steps": 0,
                    "ms": ms,
                    "detail": "browser finished without result text",
                },
                status_code=502,
            )
        # request is unused; kept so a future logging dependency has a slot.
        _ = request
        return JSONResponse(
            {"ok": True, "result": result, "steps": steps, "ms": ms}
        )
