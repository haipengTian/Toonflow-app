import { Router } from "express";
import { error } from "@/lib/responseFormat";
import type { WebAuth } from "@/lib/webAuth";

const router = Router();
export default router.post("/", (request, response) => {
  const auth = request.app.locals.webAuth as WebAuth | undefined;
  if (!auth) { response.status(404).json(error("未启用登录", null, 404)); return; }
  auth.logout(request, response);
});
