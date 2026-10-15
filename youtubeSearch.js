// Searches YouTube via the official YouTube Data API v3, so DIUBI can show
// a "what do you want to listen to" picker without the user ever leaving
// the app - tap the YouTube icon, search, tap a result, done. Needs
// YOUTUBE_API_KEY (see .env.example); search.list costs 100 quota units per
// call against the default 10,000/day free quota, so ~100 searches/day.

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

async function searchYouTube(query, maxResults = 12) {
  if (!YOUTUBE_API_KEY) {
    throw new Error("YOUTUBE_API_KEY not configured");
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("q", query);
  url.searchParams.set("key", YOUTUBE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`YouTube search HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.items || [])
    .filter((item) => item.id?.videoId)
    .map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet?.title || "",
      channelTitle: item.snippet?.channelTitle || "",
      thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || "",
    }));
}

module.exports = { searchYouTube, isConfigured: () => Boolean(YOUTUBE_API_KEY) };
