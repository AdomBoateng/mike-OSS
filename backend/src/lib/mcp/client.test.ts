import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    toolRequiresConfirmation,
    validateRemoteMcpUrl,
} from "./client";

describe("MCP tool safety classification", () => {
    test("allows only explicitly read-only, non-destructive tools", () => {
        assert.equal(toolRequiresConfirmation({ readOnlyHint: true }), false);
        assert.equal(
            toolRequiresConfirmation({
                readOnlyHint: true,
                destructiveHint: true,
            }),
            true,
        );
    });

    test("fails closed when annotations are absent or ambiguous", () => {
        assert.equal(toolRequiresConfirmation(undefined), true);
        assert.equal(toolRequiresConfirmation({}), true);
        assert.equal(toolRequiresConfirmation({ readOnlyHint: false }), true);
    });
});

describe("validateRemoteMcpUrl", () => {
    test("rejects non-HTTPS and literal private-network targets", async () => {
        await assert.rejects(() => validateRemoteMcpUrl("http://example.com/mcp"));
        await assert.rejects(() => validateRemoteMcpUrl("https://127.0.0.1/mcp"));
        await assert.rejects(() => validateRemoteMcpUrl("https://10.0.0.1/mcp"));
        await assert.rejects(() => validateRemoteMcpUrl("https://[::1]/mcp"));
    });
});
