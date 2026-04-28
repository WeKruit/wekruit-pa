"""
OpenAINanoJudge — DeepEval wrapper around OpenAI Responses API gpt-5.4-nano.

Per Adam decision 2026-04-27: route DeepEval judge through gpt-5.4-nano
(same model as agent base) for cost reasons. Trade-off: judge has same
blind spots as agent. Acceptable for milestone v1.2 to prove eval loop
works; revisit judge choice when ANTHROPIC_API_KEY is provisioned.

Locked model id: `gpt-5.4-nano`. Reads OPENAI_API_KEY from env.
Optional OPENAI_BASE_URL respected for compatible gateways.
"""

import os
from pydantic import BaseModel
from openai import OpenAI
import instructor
from deepeval.models import DeepEvalBaseLLM


class OpenAINanoJudge(DeepEvalBaseLLM):
    """
    DeepEvalBaseLLM wrapper for OpenAI gpt-5.4-nano.
    """

    def __init__(self):
        self.model_id = "gpt-5.4-nano"  # HARDCODED — never use `latest` aliases
        kwargs = {}
        base_url = os.getenv("OPENAI_BASE_URL")
        if base_url:
            kwargs["base_url"] = base_url
        self._client = OpenAI(**kwargs)

    def load_model(self):
        return self._client

    def generate(self, prompt: str, schema: BaseModel) -> BaseModel:
        instructor_client = instructor.from_openai(self.load_model())
        return instructor_client.chat.completions.create(
            model=self.model_id,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
            response_model=schema,
        )

    async def a_generate(self, prompt: str, schema: BaseModel) -> BaseModel:
        return self.generate(prompt, schema)

    def get_model_name(self) -> str:
        return self.model_id
