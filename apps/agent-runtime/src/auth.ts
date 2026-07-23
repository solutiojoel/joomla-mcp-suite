import { Router, type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { findUser, publicUser, verifyPassword, type RuntimeUser } from "./users";
import { sendError } from "./http";

const JWT_TTL_HOURS = 12;

declare module "express-serve-static-core" {
  interface Request {
    user?: RuntimeUser;
  }
}

function jwtSecret(): string {
  const secret = process.env.RUNTIME_JWT_SECRET;
  if (!secret) throw new Error("RUNTIME_JWT_SECRET is not set");
  return secret;
}

export const authRouter = Router();

authRouter.post("/api/auth/login", async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || !email || typeof password !== "string" || !password) {
    return sendError(res, 400, "validation", "email and password are required");
  }
  const user = findUser(email);
  // Same message whether the email or the password is wrong.
  if (!user || !(await verifyPassword(user, password))) {
    return sendError(res, 401, "unauthorized", "Invalid email or password");
  }
  const expiresAt = new Date(Date.now() + JWT_TTL_HOURS * 3600_000);
  const token = jwt.sign({ sub: user.email }, jwtSecret(), {
    expiresIn: `${JWT_TTL_HOURS}h`,
  });
  res.json({ token, expiresAt: expiresAt.toISOString(), user: publicUser(user) });
});

/**
 * JWT gate for everything under /api except login. Accepts the token from the
 * Authorization header, or from ?token= (EventSource can't set headers — the
 * SSE routes rely on this).
 *
 * The user record is re-read from runtime-users.json on every request, so
 * role/agent edits (or a deleted user) take effect without re-login.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const token = bearer || (typeof req.query.token === "string" ? req.query.token : "");
  if (!token) {
    return sendError(res, 401, "unauthorized", "Missing bearer token");
  }
  let email: string;
  try {
    const payload = jwt.verify(token, jwtSecret());
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      throw new Error("bad payload");
    }
    email = payload.sub;
  } catch {
    return sendError(res, 401, "unauthorized", "Invalid or expired token");
  }
  const user = findUser(email);
  if (!user) {
    return sendError(res, 401, "unauthorized", "Account no longer exists");
  }
  req.user = user;
  next();
}

export const meRouter = Router();

meRouter.get("/api/me", (req: Request, res: Response) => {
  res.json(publicUser(req.user!));
});
