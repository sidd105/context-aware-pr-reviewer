import type { ContextItem, ContextPack, DroppedItem, PackedItem } from './types.js';

// Rough but stable: about four characters per token for code and English.
// Good enough to budget with; the API reports the real number afterwards.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Required items always go in. The rest are taken by score, highest first;
// an item that doesn't fit falls back to its smaller version if it has one,
// otherwise it's dropped and listed so the report can say what was left out.
export function packContext(items: ContextItem[], budget: number): ContextPack {
  const packed: PackedItem[] = [];
  const dropped: DroppedItem[] = [];
  let used = 0;

  for (const item of items.filter((i) => i.required)) {
    const tokens = estimateTokens(item.content);
    packed.push({ ...item, tokens, usedFallback: false });
  }

  const optional = items
    .filter((i) => !i.required)
    .sort((a, b) => b.score - a.score || estimateTokens(a.content) - estimateTokens(b.content));

  for (const item of optional) {
    const tokens = estimateTokens(item.content);
    if (used + tokens <= budget) {
      packed.push({ ...item, tokens, usedFallback: false });
      used += tokens;
      continue;
    }
    if (item.fallback) {
      const fallbackTokens = estimateTokens(item.fallback.content);
      if (used + fallbackTokens <= budget) {
        packed.push({
          ...item,
          content: item.fallback.content,
          title: `${item.title} [${item.fallback.note}]`,
          tokens: fallbackTokens,
          usedFallback: true,
        });
        used += fallbackTokens;
        continue;
      }
    }
    dropped.push({ id: item.id, title: item.title, tokens, score: item.score });
  }

  return { items: packed, dropped, budget, used };
}
