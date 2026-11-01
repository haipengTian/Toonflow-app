import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error } from "@/lib/responseFormat";
import type { WebAuth } from "@/lib/webAuth";

const router = Router();
export default router.post("/", validateFields({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }), async (request, response) => {
  const auth = request.app.locals.webAuth as WebAuth | undefined;
  if (!auth) { response.status(404).json(error("未启用登录", null, 404)); return; }
  await auth.login(request, response);
});
