import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  notifyNewCollaborators,
  invitationEmail,
  addedNoticeEmail,
  type NotifyDeps,
  type NotifyOptions,
} from "./projectInvites";
import type { MailMessage } from "./mailer";

const baseOpts: NotifyOptions = {
  projectId: "proj-1",
  projectName: "Acme Merger",
  inviterLabel: "Ada Lovelace",
  newEmails: [],
};

/** Build a deps set whose sends are captured, with configurable classification. */
function makeDeps(
  over: Partial<{
    appUsers: Set<string>;
    ldapUsers: Set<string>;
    smtp: boolean;
    sendMail: (msg: MailMessage) => Promise<void>;
  }> = {},
): { deps: NotifyDeps; sent: MailMessage[] } {
  const appUsers = over.appUsers ?? new Set<string>();
  const ldapUsers = over.ldapUsers ?? new Set<string>();
  const sent: MailMessage[] = [];
  const deps: NotifyDeps = {
    smtpEnabled: () => over.smtp ?? true,
    getAuthUserByEmail: async (email) =>
      appUsers.has(email)
        ? { id: `id-${email}`, email, ldapUid: "u" }
        : null,
    ldapFindByEmail: async (email) =>
      ldapUsers.has(email)
        ? {
            ldapUid: "u",
            email,
            displayName: "X",
            organisation: null,
            dn: "dn",
          }
        : null,
    sendMail:
      over.sendMail ??
      (async (msg) => {
        sent.push(msg);
      }),
  };
  return { deps, sent };
}

describe("notifyNewCollaborators classification", () => {
  test("existing app user gets the 'added to project' notice", async () => {
    const { deps, sent } = makeDeps({ appUsers: new Set(["a@x.com"]) });
    await notifyNewCollaborators(
      { ...baseOpts, newEmails: ["a@x.com"] },
      deps,
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "a@x.com");
    assert.match(sent[0].subject, /added to/i);
  });

  test("directory-only user gets the LDAP-login invitation", async () => {
    const { deps, sent } = makeDeps({ ldapUsers: new Set(["b@x.com"]) });
    await notifyNewCollaborators(
      { ...baseOpts, newEmails: ["b@x.com"] },
      deps,
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "b@x.com");
    assert.match(sent[0].subject, /invited you to collaborate/i);
    assert.match(sent[0].text, /LDAP/);
  });

  test("app-user check takes precedence over LDAP", async () => {
    const { deps, sent } = makeDeps({
      appUsers: new Set(["c@x.com"]),
      ldapUsers: new Set(["c@x.com"]),
    });
    await notifyNewCollaborators(
      { ...baseOpts, newEmails: ["c@x.com"] },
      deps,
    );
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /added to/i);
  });

  test("unknown address (not app user, not in LDAP) receives nothing", async () => {
    const { deps, sent } = makeDeps();
    await notifyNewCollaborators(
      { ...baseOpts, newEmails: ["nobody@x.com"] },
      deps,
    );
    assert.equal(sent.length, 0);
  });

  test("mixed batch routes each recipient correctly", async () => {
    const { deps, sent } = makeDeps({
      appUsers: new Set(["user@x.com"]),
      ldapUsers: new Set(["dir@x.com"]),
    });
    await notifyNewCollaborators(
      { ...baseOpts, newEmails: ["user@x.com", "dir@x.com", "ghost@x.com"] },
      deps,
    );
    assert.equal(sent.length, 2);
    const byTo = Object.fromEntries(sent.map((m) => [m.to, m.subject]));
    assert.match(byTo["user@x.com"], /added to/i);
    assert.match(byTo["dir@x.com"], /invited you/i);
  });
});

describe("notifyNewCollaborators resilience", () => {
  test("no sends when SMTP is disabled", async () => {
    const { deps, sent } = makeDeps({
      appUsers: new Set(["a@x.com"]),
      smtp: false,
    });
    await notifyNewCollaborators(
      { ...baseOpts, newEmails: ["a@x.com"] },
      deps,
    );
    assert.equal(sent.length, 0);
  });

  test("skips empties / non-emails without sending", async () => {
    const { deps, sent } = makeDeps({ appUsers: new Set(["a@x.com"]) });
    await notifyNewCollaborators(
      { ...baseOpts, newEmails: ["", "notanemail", "a@x.com"] },
      deps,
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "a@x.com");
  });

  test("one recipient's send failure does not reject the whole call", async () => {
    const delivered: string[] = [];
    const { deps } = makeDeps({
      appUsers: new Set(["good@x.com", "bad@x.com"]),
      sendMail: async (msg) => {
        if (msg.to === "bad@x.com") throw new Error("smtp 550");
        delivered.push(msg.to);
      },
    });
    await assert.doesNotReject(
      notifyNewCollaborators(
        { ...baseOpts, newEmails: ["good@x.com", "bad@x.com"] },
        deps,
      ),
    );
    assert.deepEqual(delivered, ["good@x.com"]);
  });
});

describe("email templates", () => {
  let savedFrontend: string | undefined;
  beforeEach(() => {
    savedFrontend = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = "https://mike.example.com/";
  });
  afterEach(() => {
    if (savedFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = savedFrontend;
  });

  test("invitation points at the app root and mentions LDAP", () => {
    const tpl = invitationEmail(baseOpts);
    assert.match(tpl.text, /https:\/\/mike\.example\.com/);
    assert.ok(!tpl.text.includes("mike.example.com//")); // trailing slash trimmed
    assert.match(tpl.html, /LDAP/);
  });

  test("notice links to the specific project", () => {
    const tpl = addedNoticeEmail(baseOpts);
    assert.match(tpl.text, /https:\/\/mike\.example\.com\/projects\/proj-1/);
  });

  test("HTML is escaped to prevent injection via project name", () => {
    const tpl = invitationEmail({
      ...baseOpts,
      projectName: '<script>alert("x")</script>',
    });
    assert.ok(!tpl.html.includes("<script>"));
    assert.match(tpl.html, /&lt;script&gt;/);
  });
});
