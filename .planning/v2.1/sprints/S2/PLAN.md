# S2 — PLAN

1. AGENT_PLAN.md → worker package path, language, LiveKit Cloud deploy config
2. Worker bootstrap + agent registration
3. Wire Deepgram Nova-3 STT
4. Wire Aura-2 TTS
5. Wire Silero VAD + MultilingualModel (adaptive turn — no `minEndpointingDelay` literal)
6. Wire `openai.LLM` plugin → `WEKRUIT_LLM_SHIM_URL`
7. Turn loop: STT-commit → load context (S1B loaders) → call `PreScreenPipeline.runTurn` → stream via shim → TTS
8. Register 7 event handlers
9. Tests per event handler + turn-loop integration
10. LiveKit Cloud deploy doc'd
11. Regression gate
12. Push, SUMMARY.md, report
