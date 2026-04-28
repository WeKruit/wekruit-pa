// length-2sent.js — deterministic rubric: reply must be ≤2 sentences.
//
// Sentence boundaries detected via punctuation:
//   zh: 。！？
//   en: . ! ?
// Fragments (no terminal punctuation) count as 1 sentence.
// Returns score 1.0 if ≤2 sentences, else 0.0.

module.exports = ({ output }) => {
  const sentences = (output.match(/[。！？!?\.]+/g) || []).length;
  if (sentences <= 2) {
    return { pass: true, score: 1.0 };
  }
  return {
    pass: false,
    score: 0.0,
    reason: `Got ${sentences} sentence-ending punctuation marks, expected ≤2`,
  };
};
