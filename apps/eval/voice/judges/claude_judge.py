"""
ClaudeOpus45Judge — fixed judge model for Phase 24 voice eval.

Locked judge for Phase 24 — model ID drift risk per 24-RESEARCH.md Pitfall 3.

Never use `latest` aliases. The model ID string is hardcoded to `claude-opus-4-5`
and must not change within a milestone cycle. Score distributions are non-comparable
across model versions; any change requires a milestone bump + full re-run.
"""

from pydantic import BaseModel
from anthropic import Anthropic
import instructor
from deepeval.models import DeepEvalBaseLLM


class ClaudeOpus45Judge(DeepEvalBaseLLM):
    """
    DeepEvalBaseLLM wrapper for claude-opus-4-5.

    Locked judge for Phase 24 — model ID drift risk per 24-RESEARCH.md Pitfall 3.
    Model ID is hardcoded; never use `latest` aliases.
    CI uses async_mode=False so a_generate simply delegates to the sync path.
    """

    def __init__(self):
        self.model_id = "claude-opus-4-5"  # HARDCODED — never use `latest` aliases per Pitfall 3
        self._client = Anthropic()  # reads ANTHROPIC_API_KEY from env

    def load_model(self):
        return self._client

    def generate(self, prompt: str, schema: BaseModel) -> BaseModel:
        client = self.load_model()
        instructor_client = instructor.from_anthropic(client)
        return instructor_client.messages.create(
            model=self.model_id,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
            response_model=schema,
        )

    async def a_generate(self, prompt: str, schema: BaseModel) -> BaseModel:
        # Reuse sync path — deepeval async_mode=False default is fine for CI
        return self.generate(prompt, schema)

    def get_model_name(self) -> str:
        return f"anthropic/{self.model_id}"
