import { getTrendingTopicsAnalytics, recordActivityEvent } from "./analytics.service.js";

export async function trackActivityEventController(req, res) {
  const data = await recordActivityEvent({
    ...req.body,
    userId: req.user?.id || null,
  });

  return res.status(201).json({
    message: "Activity event tracked",
    data,
  });
}

export async function getTrendingTopicsAnalyticsController(req, res) {
  const data = await getTrendingTopicsAnalytics(req.query);
  return res.json({
    message: "Trending topics analytics fetched",
    data,
  });
}
