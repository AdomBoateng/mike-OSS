import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { userRouter } from "./routes/user";
import { downloadsRouter } from "./routes/downloads";
import { caseLawRouter } from "./routes/caseLaw";
import { authRouter } from "./routes/auth";
import { requireAuth } from "./middleware/auth";
import { smtpEnabled, verifySmtp, resolveSmtpConfig } from "./lib/mailer";
import { assertConfig } from "./lib/config";

// Safety net: Express 4 does not catch rejections thrown inside async route
// handlers, and Node crashes on an unhandled rejection. Log and keep the server
// alive (e.g. a transient DB outage should degrade requests, not kill the
// process) rather than taking the whole backend down for one failed request.
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaught exception:", err);
});

const app = express();
const PORT = process.env.PORT ?? 3001;
const isProduction = process.env.NODE_ENV === "production";

// Validate the environment before binding a port: in production a missing
// secret or unreachable-by-config dependency stops the process here rather than
// surfacing as a 500 on someone's first sign-in.
assertConfig();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

function makeLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    message: {
      detail:
        options.message ?? "Too many requests. Please try again later.",
    },
  });
}

const generalLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_GENERAL_MAX", 300),
});

const chatLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_MAX", 30),
  message: "Too many chat requests. Please try again later.",
});

const chatCreateLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_CREATE_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_CREATE_MAX", 60),
});

const uploadLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_UPLOAD_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_UPLOAD_MAX", 50),
  message: "Too many upload requests. Please try again later.",
});

const exportLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_EXPORT_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_EXPORT_MAX", 10),
  message: "Too many export requests. Please try again later.",
});

const dataDeleteLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_DATA_DELETE_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_DATA_DELETE_MAX", 20),
  message: "Too many data deletion requests. Please try again later.",
});

// Tighter limit on login to blunt password brute-forcing.
const loginLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_LOGIN_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_LOGIN_MAX", 20),
  message: "Too many login attempts. Please try again later.",
});

function jsonLimitForPath(path: string): string {
  return "50mb";
}

app.disable("x-powered-by");
app.set("trust proxy", envInt("TRUST_PROXY_HOPS", 1));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: isProduction
      ? {
          maxAge: 15552000,
          includeSubDomains: true,
        }
      : false,
    referrerPolicy: { policy: "no-referrer" },
  }),
);

// CORS. FRONTEND_URL is a comma-separated allowlist of origins. Set it to "*"
// to reflect any request origin — useful for LAN access where the app is reached
// by the server's IP (auth is Bearer-token, not cookie, so reflecting is safe
// here). Lock it to specific origins for internet-facing deployments.
const corsOrigins = (process.env.FRONTEND_URL ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const reflectAnyOrigin = corsOrigins.includes("*");

app.use(
  cors({
    origin: reflectAnyOrigin
      ? true
      : (origin, callback) => {
          // Allow same-origin / non-browser requests (no Origin header).
          if (!origin || corsOrigins.includes(origin)) callback(null, true);
          else callback(null, false);
        },
    credentials: true,
  }),
);

app.use(generalLimiter);

app.post("/chat", chatLimiter);
app.post("/projects/:projectId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/generate", chatLimiter);
app.post("/chat/create", chatCreateLimiter);
app.post("/chat/:chatId/generate-title", chatCreateLimiter);
app.post("/single-documents", uploadLimiter);
app.post("/single-documents/:documentId/versions", uploadLimiter);
app.put(
  "/single-documents/:documentId/versions/:versionId/file",
  uploadLimiter,
);
app.post("/projects/:projectId/documents", uploadLimiter);
app.get("/user/export", exportLimiter);
app.get("/user/chats/export", exportLimiter);
app.get("/user/tabular-reviews/export", exportLimiter);
app.delete("/user/account", dataDeleteLimiter);
app.delete("/user/chats", dataDeleteLimiter);
app.delete("/user/projects", dataDeleteLimiter);
app.delete("/user/tabular-reviews", dataDeleteLimiter);
app.post("/auth/login", loginLimiter);

app.use((req, res, next) =>
  express.json({ limit: jsonLimitForPath(req.path) })(req, res, next),
);

app.use("/chat", chatRouter);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);
app.use("/case-law", caseLawRouter);
app.use("/auth", authRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// SMTP self-test: confirms config + connectivity + auth (transporter.verify())
// WITHOUT sending mail. Auth-required so it isn't an open network probe.
app.get("/health/smtp", requireAuth, async (_req, res) => {
  if (!smtpEnabled()) {
    return void res.status(503).json({
      ok: false,
      detail:
        "SMTP is not configured (SMTP_HOST and SMTP_FROM are required).",
    });
  }
  const cfg = resolveSmtpConfig()!;
  try {
    await verifySmtp();
    res.json({
      ok: true,
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      from: cfg.from,
      auth: !!cfg.user,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      host: cfg.host,
      port: cfg.port,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
});
