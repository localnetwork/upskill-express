import {
  approvePayout,
  connectPayoutAccount,
  executePayout,
  listAllPayouts,
  listMyPayouts,
  rejectPayout,
  requestPayout,
} from "./payout.service.js";

export async function connectPayoutAccountController(req, res) {
  const data = await connectPayoutAccount(req.user.id, req.body);
  return res.status(201).json({ message: "Payout account connected", data });
}

export async function requestPayoutController(req, res) {
  const data = await requestPayout(req.user.id, req.body);
  return res.status(201).json({ message: "Payout requested", data });
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
  return res.json({ message: "Payout approved", data });
}

export async function rejectPayoutController(req, res) {
  const data = await rejectPayout(req.user.id, req.params.payoutId, req.body.reviewNote);
  return res.json({ message: "Payout rejected", data });
}

export async function executePayoutController(req, res) {
  const data = await executePayout(req.params.payoutId);
  return res.json({ message: "Payout executed", data });
}
