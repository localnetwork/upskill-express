import { z } from "zod";

export const listConversationsValidator = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const listMessagesValidator = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const createConversationValidator = z.object({
  participantId: z.string().trim().min(1),
  initialMessage: z.string().trim().max(5000).optional(),
});

export const sendMessageValidator = z.object({
  conversationId: z.string().trim().min(1),
  body: z.string().trim().max(5000).optional(),
  mediaPath: z.string().trim().max(2048).optional(),
  mediaType: z.enum(["IMAGE", "VIDEO"]).optional(),
});

export const searchUsersValidator = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export const deleteMessageValidator = z.object({
  mode: z.enum(["FOR_ME", "FOR_EVERYONE"]),
});
