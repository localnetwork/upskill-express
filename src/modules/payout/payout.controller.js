import {
  approvePayout,
  connectPayoutAccount,
  executePayout,
  getMyPayoutSummary,
  listAllPayouts,
  listMyPayouts,
  rejectPayout,
  requestPayout,
} from "./payout.service.js";
import { runAutoPayoutNow } from "./payout.scheduler.js";

export async function connectPayoutAccountController(req, res) {
  const data = await connectPayoutAccount(req.user.id, req.body);
  return res.status(201).json({ message: "Payout account connected", data });
}

export async function requestPayoutController(req, res) {
  const data = await requestPayout(req.user.id, req.body);
  return res.status(201).json({ message: "Payout requested", data });
}

export async function myPayoutSummaryController(req, res) {
  const data = await getMyPayoutSummary(req.user.id);
  return res.json({ message: "Payout summary fetched", data });
}

export async function listMyPayoutsController(req, res) {
  const data = await listMyPayouts(req.user.id, req.query);
  return res.json({ message: "Payout requests fetched", ...data });
}

export async function listAllPayoutsController(req, res) {
  const data = await listAllPayouts(req.query);
  return res.json({ message: "Payout requests fetched", ...data });
}

export async function approvePayoutController(req, res) {
  const data = await approvePayout(req.user.id, req.params.payoutId, req.body.reviewNote);
  return res.json({ message: "Payout approved and submitted to PayPal", data });
}

export async function rejectPayoutController(req, res) {
  const data = await rejectPayout(req.user.id, req.params.payoutId, req.body.reviewNote);
  return res.json({ message: "Payout rejected", data });
}

export async function executePayoutController(req, res) {
  const data = await executePayout(req.params.payoutId);
  return res.json({ message: "Payout executed", data });
}

export async function runAutoPayoutController(_req, res) {
  const data = await runAutoPayoutNow("admin-manual-trigger");
  return res.json({ message: "Auto payout process completed", data });
}
