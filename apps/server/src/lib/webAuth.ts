import express from "express";
import type { Request, Response, RequestHandler } from "express";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { error, success } from "@/lib/responseFormat";
import { loginPage } from "@/lib/loginPage";

const deriveKey = promisify(scrypt);
const sessionLifetime = 24 * 60 * 60 * 1000;

export function readWebAuthConfig() {
  const enabled = process.env.TOONFLOW_AUTH_ENABLED;
  if (!enabled || enabled === "false") return undefined;
  if (enabled !== "true") throw new Error("TOONFLOW_AUTH_ENABLED 必须为 true 或 false");
  const username = process.env.TOONFLOW_AUTH_USERNAME ?? "";
  const passwordHash = process.env.TOONFLOW_AUTH_PASSWORD_HASH ?? "";
  const origin = process.env.TOONFLOW_PUBLIC_ORIGIN ?? "";
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("TOONFLOW_PUBLIC_ORIGIN 必须是 HTTPS 来源地址（本机调试可用 HTTP）");
  }
  if (!/^[a-zA-Z0-9@._-]{1,64}$/.test(username) || !/^[a-f0-9]{64}:[a-f0-9]{128}$/.test(passwordHash)) {
    throw new Error("请配置管理员用户名和 scrypt 密码摘要");
  }
  return { username, passwordHash, origin };
}

export function createWebAuth(config: NonNullable<ReturnType<typeof readWebAuthConfig>>, authorizeMachine: (request: Request) => boolean,
  internalOperations: { path: string; method: string }[]) {
  const origin = new URL(config.origin);
  const secure = origin.protocol === "https:";
  const cookieName = secure ? "__Host-toonflowSession" : "toonflowSession";
  const cookieOptions = { httpOnly: true, secure, sameSite: "strict" as const, path: "/" };
  const sessions = new Map<string, { expires: number; responses: Set<Response> }>();
  const internalToken = randomBytes(32).toString("hex");
  // ACT: 单管理员入口全局每分钟最多 10 次尝试、同时最多 2 次密码校验，不信任代理传来的 IP。
  let attemptWindow = 0;
  let attempts = 0;
  let verifying = 0;

  function readToken(request: Request) {
    const entry = request.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
    const token = entry?.slice(cookieName.length + 1) ?? "";
    return /^[a-f0-9]{64}$/.test(token) ? token : "";
  }

  function revoke(token: string) {
    const session = sessions.get(token);
    sessions.delete(token);
    for (const response of session?.responses ?? []) response.end();
  }

  function getSession(request: Request) {
    const token = readToken(request);
    const session = sessions.get(token);
    if (session && session.expires <= Date.now()) { revoke(token); return undefined; }
    return session;
  }

  const middleware: RequestHandler = (request, response, next) => {
    response.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
    // 机器客户端沿用所属协议的有效 Bearer；内部 HTTP 仅允许进程内随机凭据、loopback 和既有操作白名单。
    if (authorizeMachine(request)) return next();
    const actualInternal = Buffer.from(request.get("x-toonflow-internal") ?? "");
    if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")
      && actualInternal.length === internalToken.length && timingSafeEqual(actualInternal, Buffer.from(internalToken))
      && internalOperations.some(operation => operation.path === request.path && operation.method === request.method)) return next();
    let source: string | undefined;
    try { source = request.get("origin") ?? (request.get("referer") ? new URL(request.get("referer")!).origin : undefined); }
    catch { source = "invalid"; }
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (request.get("host") === origin.host && request.path === "/login" && request.method === "GET") {
      response.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      response.type("html").send(loginPage(Boolean(getSession(request)), request.query.error));
      return;
    }
    if (request.get("host") === origin.host && request.method === "GET" && request.get("sec-fetch-mode") === "navigate"
      && request.path === "/" && (source !== undefined && source !== config.origin || request.get("sec-fetch-site") === "cross-site")) {
      response.redirect(303, config.origin + "/login");
      return;
    }
    if (request.get("host") !== origin.host || (source !== undefined && source !== config.origin)
      || request.get("sec-fetch-site") === "cross-site" || (unsafe && source !== config.origin)) {
      response.status(403).json(error("页面来源与服务地址不一致", null, 403));
      return;
    }
    if ((request.path === "/api/auth/login" && request.method === "POST")
      || (request.path === "/api/auth/session" && request.method === "GET")) return next();
    const session = getSession(request);
    if (!session) {
      if (request.method === "GET" && request.get("sec-fetch-mode") === "navigate") response.redirect(303, "/login");
      else response.set("X-Toonflow-Auth", "required").status(401).json(error("请先登录", null, 401));
      return;
    }
    session.responses.add(response);
    const expiry = setTimeout(() => revoke(readToken(request)), Math.max(1, session.expires - Date.now()));
    expiry.unref();
    const release = () => { clearTimeout(expiry); session.responses.delete(response); };
    response.once("finish", release);
    response.once("close", release);
    next();
  };

  async function login(request: Request, response: Response) {
    if (Date.now() - attemptWindow >= 60000) { attemptWindow = Date.now(); attempts = 0; }
    if (++attempts > 10 || verifying >= 2) {
      response.set("Retry-After", "60");
      if (request.is("application/x-www-form-urlencoded")) response.redirect(303, "/login?error=limited");
      else response.status(429).json(error("尝试过于频繁，请一分钟后重试", null, 429));
      return;
    }
    verifying++;
    let valid = false;
    try {
      const [salt, expected] = config.passwordHash.split(":");
      const actual = await deriveKey(request.body.password, Buffer.from(salt!, "hex"), 64) as Buffer;
      valid = timingSafeEqual(actual, Buffer.from(expected!, "hex")) && request.body.username === config.username;
    } finally { verifying--; }
    if (!valid) {
      if (request.is("application/x-www-form-urlencoded")) response.redirect(303, "/login?error=invalid");
      else response.status(401).json(error("用户名或密码不正确", null, 401));
      return;
    }
    revoke(readToken(request));
    for (const [token, session] of sessions) if (session.expires <= Date.now()) revoke(token);
    while (sessions.size >= 32) revoke(sessions.keys().next().value!);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { expires: Date.now() + sessionLifetime, responses: new Set() });
    response.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionLifetime });
    if (request.is("application/x-www-form-urlencoded")) response.redirect(303, "/");
    else response.json(success());
  }

  function logout(request: Request, response: Response) {
    // 先完成退出响应，再关闭该会话仍在运行的流。
    const token = readToken(request);
    sessions.get(token)?.responses.delete(response);
    response.clearCookie(cookieName, cookieOptions);
    if (request.is("application/x-www-form-urlencoded")) response.redirect(303, "/login");
    else response.json(success());
    revoke(token);
  }

  return { middleware, login, logout, authenticated: (request: Request) => Boolean(getSession(request)),
    internalRequestHeaders: { "x-toonflow-internal": internalToken },
    bodyParser: [express.json({ limit: "4kb" }), express.urlencoded({ extended: false, limit: "4kb", parameterLimit: 4 })] };
}

export type WebAuth = ReturnType<typeof createWebAuth>;
