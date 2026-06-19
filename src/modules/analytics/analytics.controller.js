import { recordActivityEvent } from "./analytics.service.js";

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

