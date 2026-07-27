export async function webSearch(query, limit = 5) {
  const key = process.env.SERPER_API_KEY || process.env.SERP_DEV_KEYY;
  if (!key) {
    return { query, skipped: true, reason: "SERPER_API_KEY is not configured", results: [] };
  }

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": key,
    },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!response.ok) {
    return {
      query,
      skipped: true,
      reason: `Serper HTTP ${response.status}`,
      results: [],
    };
  }
  const data = await response.json();
  const results = [...(data.organic || []), ...(data.news || [])].slice(0, limit).map((item) => ({
    title: item.title || "",
    link: item.link || "",
    snippet: item.snippet || "",
  }));
  return { query, skipped: false, results };
}
