"""
test_voice_baseline.py — Phase 24 voice eval entry point.

Runs ClaireVoice + NoCoachMode ConversationalGEval metrics against
the golden-50 labeled dataset. Falls back to golden-50.template.jsonl
if the real golden-50.jsonl is not yet present (populated in plan 02).

Usage:
  PA_RUN_EVAL=1 deepeval test run test_voice_baseline.py -n 4
  PA_RUN_EVAL=1 deepeval test run test_voice_baseline.py -k regression-anchor

The conftest.py PA_RUN_EVAL guard will skip all tests unless PA_RUN_EVAL=1
is set, preventing accidental Claude API spend.
"""

import json
import logging
import os
import warnings
from pathlib import Path

import pytest
from deepeval import assert_test
from deepeval.metrics import ConversationalGEval
from deepeval.test_case import ConversationalTestCase, Turn

from judges.claude_judge import ClaudeOpus45Judge

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Judge singleton + threshold
# ---------------------------------------------------------------------------
JUDGE = ClaudeOpus45Judge()
THRESHOLD = float(os.getenv("CLAIRE_VOICE_THRESHOLD", "0.7"))

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
CLAIRE_VOICE_METRIC = ConversationalGEval(
    name="ClaireVoice",
    criteria=(
        "Claire is a Bay Area engineering manager texting a friend over iMessage. "
        "Score HIGH (>=0.7) when: reply is <=2 sentences; no markdown bullets or numbered lists; "
        "no coach-mode verbs (我建议你/你应该/保持积极心态/首先其次); "
        "no pop-therapy phrases (接住你/硬撑着/hold space); "
        "code-switches zh/en the way user does; at most 1 emoji 💀>😭>🥲 NEVER 😂; "
        "tone matches scenario (vent->sit-with, celebrate->hype, ask->straight). "
        "Score LOW (<=0.3) when: numbered steps present; coach-mode probe at end; "
        "4+ subordinate clauses; no slang/fragments; formal punctuation throughout."
    ),
    threshold=THRESHOLD,
    model=JUDGE,
    async_mode=False,
)

NO_COACH_METRIC = ConversationalGEval(
    name="NoCoachMode",
    criteria=(
        "Score PASS (1.0) when the assistant reply contains NONE of: "
        "我建议你, 你应该, 我推荐, 听起来你, 保持积极心态, 你的感受是合理的, "
        "我们一步一步来, 不妨试试, 总之要相信自己, 加油哦~, 宝~, 亲~, "
        "I suggest, Maybe you should, I recommend, I hear you (as opener), I understand (as opener), "
        "bullet lists, numbered steps. Score FAIL (0.0) if any appear."
    ),
    threshold=0.9,
    model=JUDGE,
    strict_mode=True,
    async_mode=False,
)

# ---------------------------------------------------------------------------
# Fixture loader
# ---------------------------------------------------------------------------
_FIXTURE_DIR = Path(__file__).parent / "fixtures"


def _load(path: str) -> list[dict]:
    """Load a JSONL file and return list of parsed objects (skips blank lines)."""
    p = Path(path)
    if not p.is_absolute():
        # Resolve relative to this file's directory
        p = Path(__file__).parent / path
    cases = []
    with open(p) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("//"):
                cases.append(json.loads(line))
    return cases


# ---------------------------------------------------------------------------
# Load golden dataset (with template fallback)
# ---------------------------------------------------------------------------
_GOLDEN_PATH = _FIXTURE_DIR / "golden-50.jsonl"
_TEMPLATE_PATH = _FIXTURE_DIR / "golden-50.template.jsonl"

try:
    GOLDENS = _load(str(_GOLDEN_PATH))
    logger.info("Loaded %d cases from golden-50.jsonl", len(GOLDENS))
except FileNotFoundError:
    warnings.warn(
        f"golden-50.jsonl not found at {_GOLDEN_PATH}. "
        "Falling back to golden-50.template.jsonl (placeholder cases). "
        "Run plan 02 (HITL labeling) to populate the real dataset.",
        UserWarning,
        stacklevel=2,
    )
    GOLDENS = _load(str(_TEMPLATE_PATH))
    logger.info("Loaded %d placeholder cases from golden-50.template.jsonl", len(GOLDENS))

# ---------------------------------------------------------------------------
# Parametrized test
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("g", GOLDENS, ids=[g["id"] for g in GOLDENS])
def test_claire_voice(g: dict):
    """
    Run ClaireVoice + NoCoachMode metrics on each golden case.

    Cases tagged `regression-anchor` are the minimum gate for Wave 2.
    Run anchors-only: deepeval test run test_voice_baseline.py -k regression-anchor
    """
    turns = [Turn(role=t["role"], content=t["content"]) for t in g["turns"]]
    tc = ConversationalTestCase(
        turns=turns,
        name=g.get("id", ""),
        tags=g.get("tags", []),
    )
    assert_test(tc, [CLAIRE_VOICE_METRIC, NO_COACH_METRIC])
