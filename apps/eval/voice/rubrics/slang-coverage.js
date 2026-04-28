// slang-coverage.js — deterministic rubric: presence of verified 2025-26 网感 slang.
//
// Whitelist sourced from MILESTONE-v1.2.md "Web-Verified 网感 Corpus" (2026-04-27).
// This rubric is INFORMATIONAL — never blocks CI. Telemetry only.
// score=1.0 if ≥1 verified slang phrase present; score=0.5 if none (ok for short replies).

const VERIFIED_2026 = [
  // zh — verified alive 2025-26 (微博 / 小红书 / 1point3acres)
  "老登",
  "活人感",
  "邪修",
  "主理人",
  "误闯天家",
  "预制",
  "赛博对账",
  "如何呢，又能怎",
  "班味",
  "去班味",
  "拼好",
  "职场申公豹",
  "真没空陪你闹了",
  "发疯工牌",
  "蒜鸟",

  // zh — legacy still alive
  "卷",
  "摆烂",
  "躺平",
  "emo",
  "破防",
  "听劝",
  "i人",
  "e人",
  "测评",
  "显眼包",
  "柠檬",

  // en Gen Z 2025-26 (Reddit / TikTok / Smithsonian)
  "delulu",
  "cooked",
  "mid",
  "brainrot",
  "slop",
  "lock in",
  "yapping",
  "glazing",
  "aura",
  "mother is mothering",
  "demure",
  "ragebait",
  "crash out",
  "NPC",
  "canon event",
  "iykyk",

  // en legacy still alive
  "lowkey",
  "fr",
  "deadass",
  "manifest",
  "next",
];

module.exports = ({ output }) => {
  const lower = output.toLowerCase();
  const hit = VERIFIED_2026.some((s) => lower.includes(s.toLowerCase()));
  // Coverage rubric is informational — never blocks. Telemetry only.
  return {
    pass: true,
    score: hit ? 1.0 : 0.5,
    reason: hit
      ? "verified slang present"
      : "no verified slang (ok for short replies)",
  };
};
