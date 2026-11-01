// Eval-only batches; explicit categories keep the expected totals independent of the model.
export const BATCHES = [
  ["AI", "Programming", "Other", "AI", "Programming", "Other", "AI", "Programming"],
  ["Other", "AI", "Programming", "Other", "AI", "Programming", "Other", "AI"],
  ["Programming", "Other", "AI", "Programming", "Other", "AI", "Programming", "Other"],
].map((categories, batch) => categories.map((category, i) => ({ title: `${category} link ${batch + 1}-${i + 1}`, url: `https://example.com/b${batch + 1}/${i + 1}`, category })));
export const EXPECTED = { total: BATCHES.flat().length, categories: Object.fromEntries(["AI", "Programming", "Other"].map(name => [name, BATCHES.flat().filter(link => link.category === name).length])) };
