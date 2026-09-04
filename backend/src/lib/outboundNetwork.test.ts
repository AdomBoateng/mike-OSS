import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isBlockedNetworkAddress,
  validatePublicUrl,
} from "./outboundNetwork";

describe("outbound network validation", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "64:ff9b::7f00:1",
  ]) {
    it(`blocks non-public address ${address}`, () => {
      assert.equal(isBlockedNetworkAddress(address), true);
    });
  }

  it("allows ordinary public addresses", () => {
    assert.equal(isBlockedNetworkAddress("1.1.1.1"), false);
    assert.equal(isBlockedNetworkAddress("2606:4700:4700::1111"), false);
  });

  it("rejects local and metadata targets", async () => {
    await assert.rejects(
      () => validatePublicUrl("https://127.0.0.1/v1", { httpsOnly: true }),
      /blocked network/i,
    );
    await assert.rejects(
      () =>
      validatePublicUrl("https://metadata.google.internal/", {
        httpsOnly: true,
      }),
      /blocked host/i,
    );
  });

  it("requires HTTPS when requested", async () => {
    await assert.rejects(
      () => validatePublicUrl("http://1.1.1.1/v1", { httpsOnly: true }),
      /HTTPS/i,
    );
  });
});
