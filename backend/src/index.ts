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
import { assertConfig, assertDependenciesReachable } from "./lib/config";
import { normalizeBasePath, stripBasePath } from "./lib/basePath";
import { query as dbQuery } from "./lib/db";

// Safety net: Express 4 does not catch rejections thrown inside async route
// handlers, and Node crashes on an unhandled rejection. Log and keep the server
// alive (e.g. a transient DB outage should degrade requests, not kill the
// process) rather than taking the whole backend down for one failed request.
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaught exception:", err);
  // An uncaught exception can leave application state corrupted. Let the
  // container/process supervisor replace this instance instead of continuing
  // to serve traffic from an unknown state.
  process.exit(1);
});

const app = express();
const PORT = process.env.PORT ?? 3001;
const isProduction = process.env.NODE_ENV === "production";

// Validate the environment before binding a port: in production a missing
// secret or unreachable-by-config dependency stops the process here rather than
// surfacing as a 500 on someone's first sign-in.
//
// Keep validation inside start() so startup failures follow its explicit
// non-zero exit path and produce a clear diagnostic.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

const mfaLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_MFA_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_MFA_MAX", 10),
  message: "Too many verification attempts. Please try again later.",
});

function jsonBodyLimit(): string {
  const configured = process.env.JSON_BODY_LIMIT?.trim();
  return configured && /^\d+(?:kb|mb)$/i.test(configured)
    ? configured
    : "5mb";
}

app.disable("x-powered-by");
// Directly-published compose deployments have no trusted proxy. Defaulting to
// one hop lets a client spoof X-Forwarded-For and rotate the rate-limit key.
// Kubernetes explicitly sets this to 1 because its ingress is one real hop.
app.set("trust proxy", envNonNegativeInt("TRUST_PROXY_HOPS", 0));

// Mounted under a path prefix when one hostname serves both apps and the
// ingress routes /api to this service (see docs/KUBERNETES.md). Stripping it
// here rather than in the ingress keeps the manifests controller-agnostic.
// Empty by default, which is the port-per-service shape docker-compose uses.
//
// This must run before the rate limiters below: they key on the path, and a
// limiter registered for "/auth/login" never matches "/api/auth/login".
const API_BASE_PATH = normalizeBasePath(process.env.API_BASE_PATH);
if (API_BASE_PATH) {
  app.use((req, _res, next) => {
    const stripped = stripBasePath(req.url, API_BASE_PATH);
    if (stripped !== null) req.url = stripped;
    next();
  });
  console.log(`[server] API mounted under ${API_BASE_PATH}`);
}

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

// API responses contain legal documents, user settings, and bearer tokens.
// Do not let browsers or shared intermediaries retain them by default.
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
});

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
    // Authentication is an explicit Bearer header; cross-origin requests do
    // not need ambient cookies or HTTP authentication credentials.
    credentials: false,
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
// The same router is intentionally mounted at /user and /users. Mirror every
// route-specific limiter so the alias cannot be used to bypass it.
app.get("/users/export", exportLimiter);
app.get("/users/chats/export", exportLimiter);
app.get("/users/tabular-reviews/export", exportLimiter);
app.delete("/users/account", dataDeleteLimiter);
app.delete("/users/chats", dataDeleteLimiter);
app.delete("/users/projects", dataDeleteLimiter);
app.delete("/users/tabular-reviews", dataDeleteLimiter);
app.post("/user/security/mfa/verify", mfaLimiter);
app.post("/user/security/mfa/challenge", mfaLimiter);
app.post("/users/security/mfa/verify", mfaLimiter);
app.post("/users/security/mfa/challenge", mfaLimiter);
app.post("/auth/login", loginLimiter);

app.use((req, res, next) =>
  express.json({ limit: jsonBodyLimit() })(req, res, next),
);

app.use("/chat", chatRouter);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
// Same router under a name that is not a lie for the cross-project routes:
// "/single-documents" means project-less documents, but /documents/overview
// spans every document the user can reach. Mirrors the /user + /users pairing.
app.use("/documents", documentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);
app.use("/case-law", caseLawRouter);
app.use("/auth", authRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Readiness, for an orchestrator that decides whether to send this pod traffic.
// /health above is liveness: it says the process is up, which a pod whose
// database has gone away will happily keep saying while failing every real
// request. Kubernetes takes a pod out of the Service on this one WITHOUT
// restarting it, which is the right response to the database being briefly
// away — a restart would not have helped and the pod recovers on its own.
app.get("/health/ready", async (_req, res) => {
  try {
    await dbQuery("select 1", []);
    res.json({ ok: true });
  } catch (err) {
    console.error("[health/ready] database probe failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({
      ok: false,
      detail: "A required service is unavailable.",
    });
  }
});

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
    res.json({ ok: true });
  } catch (err) {
    console.error("[health/smtp] SMTP probe failed", {
      host: cfg.host,
      port: cfg.port,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({
      ok: false,
      detail: "SMTP verification failed.",
    });
  }
});

// Graceful shutdown.
//
// Kubernetes sends SIGTERM and waits terminationGracePeriodSeconds before
// SIGKILL; Node's default action for SIGTERM is to exit immediately. Here that
// would cut every answer being streamed at that moment off mid-sentence, and an
// answer can legitimately take ten minutes — during a rolling update "a request
// is in flight" is the normal case, not a rare one.
//
// So: stop listening, hang up connections that are merely idle between
// keep-alive requests, and let the ones actually mid-response finish. The pod
// has already been removed from the Service by the time this runs, so nothing
// new arrives. If the grace period runs out first, Kubernetes kills us anyway,
// which is no worse than exiting on the signal.
let httpServer: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!httpServer) {
    console.log(`[server] ${signal} received before listening; exiting`);
    process.exit(0);
  }
  console.log(
    `[server] ${signal} received; refusing new connections and waiting for ` +
      `in-flight requests to finish`,
  );
  httpServer.close(() => {
    console.log("[server] all connections closed; exiting");
    process.exit(0);
  });
  // Without this, a browser holding an idle keep-alive socket open keeps
  // close() waiting for the full grace period even though nothing is happening
  // on it.
  httpServer.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function start(): Promise<void> {
  assertConfig();
  // Config only proves S3 and LDAP are *configured*; this proves they answer.
  // A deployment with no route to the storage subnet fails here rather than on
  // a user's first upload, and one that cannot reach the directory fails here
  // rather than when someone tries to sign in.
  await assertDependenciesReachable();

  // listen() reports failures by emitting "error", not by throwing, so without
  // this a busy port would reach the uncaughtException handler above and the
  // process would sit there having never bound anything.
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(PORT, () => {
      console.log(`Mike backend running on port ${PORT}`);
      resolve();
    });
    server.once("error", reject);
    httpServer = server;
  });
}

// The process-level handlers above deliberately keep the server alive through
// runtime faults, but a failed startup check is not a runtime fault — there is
// nothing to keep alive. Exit non-zero so the supervisor sees a real failure.
start().catch((err) => {
  console.error(
    `[server] startup aborted: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
