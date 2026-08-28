// Quantum Group logo, inlined as base64 so it ships with the compiled output
// (tsc only emits .ts, and the runtime image copies only dist/) and needs no
// asset-copy step in the Dockerfile.
//
// Source: https://www.quantumgroupgh.com/ (white wordmark, 644x176 PNG). It is
// attached to each email with a Content-ID and referenced as <img src="cid:…">
// rather than hotlinked, so the logo renders in clients that block remote
// images and does not depend on the marketing site staying reachable.

/** Content-ID used to reference the logo from the email HTML. */
export const LOGO_CID = "quantum-logo";

/** File name shown if a client lists the inline attachment. */
export const LOGO_FILENAME = "quantum-group-logo.png";

/** Rendered size in the email header (half the intrinsic size, for retina). */
export const LOGO_WIDTH = 161;
export const LOGO_HEIGHT = 44;

export const LOGO_PNG_BASE64 =
  "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" +
  "YII=";
