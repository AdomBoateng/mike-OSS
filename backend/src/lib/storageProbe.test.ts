import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { probeStorage, resetStorageClient } from "./storage";

// The probe's whole value is telling "the network cannot reach storage" apart
// from "storage answered and said no" — those have completely different fixes,
// and only the first one is a routing problem. These tests drive it against a
// real local server so the classification is checked against the error shapes
// the AWS SDK actually produces, not a hand-written mock of them.

const REAL_ENV = { ...process.env };
const servers: http.Server[] = [];

afterEach(async () => {
  process.env = { ...REAL_ENV };
  resetStorageClient();
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** Start a server that answers every request with `status`. */
async function serverReturning(status: number): Promise<number> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function configureStorage(endpoint: string): void {
  process.env.S3_ENDPOINT_URL = endpoint;
  process.env.S3_ACCESS_KEY_ID = "key";
  process.env.S3_SECRET_ACCESS_KEY = "secret";
  process.env.S3_BUCKET_NAME = "mike";
  resetStorageClient();
}

describe("probeStorage", () => {
  test("unconfigured storage is reported as such, not as unreachable", async () => {
    for (const k of [
      "S3_ENDPOINT_URL",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "R2_ENDPOINT_URL",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ]) {
      delete process.env[k];
    }
    resetStorageClient();
    const r = await probeStorage();
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.kind, "unconfigured");
  });

  test("a bucket that answers 200 is reachable", async () => {
    configureStorage(`http://127.0.0.1:${await serverReturning(200)}`);
    const r = await probeStorage();
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.bucket, "mike");
  });

  test("a closed port is unreachable — the routing case this exists for", async () => {
    // Bind a port, then close it, so nothing is listening on an address we know
    // is otherwise valid. This is the shape a missing route/firewall rule takes.
    const port = await serverReturning(200);
    await new Promise<void>((resolve) =>
      servers.splice(0)[0].close(() => resolve()),
    );
    configureStorage(`http://127.0.0.1:${port}`);
    const r = await probeStorage();
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.kind, "unreachable");
  });

  test("403 is a credentials problem, NOT unreachable", async () => {
    // The distinction matters: reporting this as a network fault would send
    // someone to the firewall team over a bad access key.
    configureStorage(`http://127.0.0.1:${await serverReturning(403)}`);
    const r = await probeStorage();
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.kind, "denied");
  });

  test("404 means the endpoint is fine but the bucket is missing", async () => {
    configureStorage(`http://127.0.0.1:${await serverReturning(404)}`);
    const r = await probeStorage();
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.kind, "no_such_bucket");
  });

  test("an unexpected status is reported without being called unreachable", async () => {
    configureStorage(`http://127.0.0.1:${await serverReturning(500)}`);
    const r = await probeStorage();
    assert.equal(r.ok, false);
    assert.notEqual(r.ok === false && r.kind, "unreachable");
  });
});
