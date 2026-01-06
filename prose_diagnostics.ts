const VAGUE_WORDS = [
  "somehow",
  "something",
  "someone",
  "stuff",
  "things",
  "maybe",
  "perhaps",
  "sort of",
  "kind of",
  "a bit",
  "a little",
  "very",
  "really"
];

const FILLER_PHRASES = [
  "small breath",
  "let out a breath",
  "breath he didn't know he was holding",
  "eyes widened",
  "heart pounded",
  "couldn't help but",
  "for a moment",
  "in that moment"
];

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  const re = new RegExp(escapeRegExp(needle), "gi");
  const m = haystack.match(re);
  return m ? m.length : 0;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitSentences(text: string) {
  // Conservative splitter; keeps it deterministic.
  const parts = text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“‘])/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : (text.trim() ? [text.trim()] : []);
}

function words(text: string) {
  const m = text.match(/[A-Za-z0-9']+/g);
  return m ?? [];
}

// Approximate syllable counting for Flesch readability.
function countSyllables(word: string) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const matches = w.match(/[aeiouy]+/g);
  let syllables = matches ? matches.length : 1;
  // silent e
  if (w.endsWith("e") && syllables > 1) syllables -= 1;
  return Math.max(1, syllables);
}

function fleschReadingEase(text: string) {
  const ws = words(text);
  const sentenceCount = splitSentences(text).length || 1;
  const wordCount = ws.length || 1;
  const syllables = ws.reduce((sum, w) => sum + countSyllables(w), 0);
  const asl = wordCount / sentenceCount;
  const asw = syllables / wordCount;
  // 206.835 - 1.015*(words/sentences) - 84.6*(syllables/words)
  return 206.835 - 1.015 * asl - 84.6 * asw;
}

function dialogueRatio(text: string) {
  const total = text.length || 1;
  const quoted = (text.match(/"[^"]*"/g) ?? []).join("").length;
  return Math.max(0, Math.min(1, quoted / total));
}

export function analyzeProse(text: string) {
  const ws = words(text);
  const sents = splitSentences(text);

  const wordCount = ws.length;
  const sentenceCount = sents.length;

  const avgSentenceWords = sentenceCount ? wordCount / sentenceCount : 0;

  const adverbLike = (text.match(/\b\w+ly\b/gi) ?? []).length;
  const vagueWordCount = VAGUE_WORDS.reduce((sum, w) => sum + countOccurrences(text, w), 0);
  const fillerPhraseCount = FILLER_PHRASES.reduce((sum, p) => sum + countOccurrences(text, p), 0);

  const metaphorMarkers =
    (text.match(/\b(like|as if|as though)\b/gi) ?? []).length +
    (text.match(/\bwas a\b/gi) ?? []).length;

  const dRatio = dialogueRatio(text);

  const readability = fleschReadingEase(text);

  return {
    metrics: {
      word_count: wordCount,
      sentence_count: sentenceCount,
      avg_sentence_words: Number.isFinite(avgSentenceWords) ? avgSentenceWords : 0,
      adverb_like_count: adverbLike,
      vague_word_count: vagueWordCount,
      filler_phrase_count: fillerPhraseCount,
      metaphor_marker_count: metaphorMarkers,
      dialogue_ratio: dRatio,
      readability_flesch: Number.isFinite(readability) ? readability : undefined
    }
  };
}
