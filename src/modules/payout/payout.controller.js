import {
  approvePayout,
  connectPayoutAccount,
  executePayout,
  getMyPayoutSummary,
  handleXenditPayoutWebhook,
  listAllPayouts,
  listMyPayouts,
  rejectPayout,
  requestPayout,
  retryMyFailedPayout,
  returnMyFailedPayout,
  getAccountVerificationMethod,
  verifyAccountOwnership,
} from "./payout.service.js";
import { runAutoPayoutNow } from "./payout.scheduler.js";

export async function verifyAccountPasswordController(req, res) {
  const data = await verifyAccountOwnership(req.user.id, req.body);
  return res.json({ message: "Verified", data });
}

export async function accountVerificationMethodController(req, res) {
  const data = await getAccountVerificationMethod(req.user.id);
  return res.json({ message: "Verification method", data });
}

export async function connectPayoutAccountController(req, res) {
  const data = await connectPayoutAccount(req.user.id, req.body);
  return res.status(201).json({ message: "Payout account connected", data });
}

export async function requestPayoutController(req, res) {
  const data = await requestPayout(req.user.id, req.body);
  return res.status(201).json({ message: "Payout auto-approved and submitted", data });
}

export async function retryMyPayoutController(req, res) {
  const data = await retryMyFailedPayout(req.user.id, req.params.payoutId);
  return res.json({ message: "Payout retried", data });
}

export async function returnMyPayoutController(req, res) {
  const data = await returnMyFailedPayout(req.user.id, req.params.payoutId);
  return res.json({ message: "Payout amount returned to balance", data });
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
  return res.json({ message: "Payout approved and submitted to Xendit", data });
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

export async function payoutWebhookController(req, res) {
  const data = await handleXenditPayoutWebhook(req.body, req.headers);
  return res.status(202).json({ message: "Payout webhook accepted", data });
}
