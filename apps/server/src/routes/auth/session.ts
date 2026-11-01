import { Router } from "express";
import { success } from "@/lib/responseFormat";
import type { WebAuth } from "@/lib/webAuth";

const router = Router();
export default router.get("/", (request, response) => {
  const auth = request.app.locals.webAuth as WebAuth | undefined;
  response.set("Cache-Control", "no-store").json(success({ enabled: Boolean(auth), authenticated: Boolean(auth?.authenticated(request)) }));
});
