"""
conftest.py — pytest configuration for voice eval (Phase 24).

Loads .env (best-effort), creates a singleton ClaudeOpus45Judge, exposes it
as a pytest fixture, and guards against accidental API spend.

Guard behaviour:
- If PA_RUN_EVAL is not set: skip all tests with a cost-warning message.
- If PA_RUN_EVAL=1 but ANTHROPIC_API_KEY is not set: raise UsageError (hard fail).
"""

import os
import pytest

# Best-effort: load .env from the eval workspace directory (or repo root).
try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=False)
    # Fall back to repo-root .env if workspace .env not present.
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "..", "..", ".env"), override=False)
except ImportError:
    pass  # python-dotenv not installed — rely on shell env

# ---------------------------------------------------------------------------
# Global guard: skip unless PA_RUN_EVAL=1
# ---------------------------------------------------------------------------
PA_RUN_EVAL = os.getenv("PA_RUN_EVAL", "").strip()

if not PA_RUN_EVAL:
    # Collect phase: skip all items with an informative message.
    collect_ignore_glob = ["test_*.py"]

    def pytest_collection_modifyitems(items, config):
        skip_marker = pytest.mark.skip(
            reason=(
                "Set PA_RUN_EVAL=1 to run voice eval (incurs Claude API cost). "
                "Example: PA_RUN_EVAL=1 deepeval test run test_voice_baseline.py -n 4"
            )
        )
        for item in items:
            item.add_marker(skip_marker)

else:
    # PA_RUN_EVAL is set — validate ANTHROPIC_API_KEY is present.
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise pytest.UsageError(
            "PA_RUN_EVAL=1 is set but ANTHROPIC_API_KEY is not. "
            "Provision ANTHROPIC_API_KEY before running voice eval. "
            "See apps/eval/voice/README.md for setup instructions."
        )

# ---------------------------------------------------------------------------
# Judge singleton + fixture
# ---------------------------------------------------------------------------
_PA_VOICE_JUDGE = os.getenv("PA_VOICE_JUDGE", "nano").strip().lower()
if _PA_VOICE_JUDGE == "claude":
    from judges.claude_judge import ClaudeOpus45Judge  # noqa: E402 — after guard
    JUDGE = ClaudeOpus45Judge()
else:
    from judges.openai_nano_judge import OpenAINanoJudge  # noqa: E402 — after guard
    JUDGE = OpenAINanoJudge()


@pytest.fixture(scope="session")
def judge():
    """Return the module-level ClaudeOpus45Judge singleton."""
    return JUDGE
