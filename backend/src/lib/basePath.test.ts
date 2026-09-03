import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { normalizeBasePath, stripBasePath } from "./basePath";

describe("normalizeBasePath", () => {
  test("unset, empty and '/' all mean 'not mounted under a prefix'", () => {
    assert.equal(normalizeBasePath(undefined), "");
    assert.equal(normalizeBasePath(""), "");
    assert.equal(normalizeBasePath("   "), "");
    assert.equal(normalizeBasePath("/"), "");
  });

  test("accepts the three spellings someone actually types", () => {
    assert.equal(normalizeBasePath("api"), "/api");
    assert.equal(normalizeBasePath("/api"), "/api");
    assert.equal(normalizeBasePath("/api/"), "/api");
  });

  test("a nested prefix survives", () => {
    assert.equal(normalizeBasePath("/mike/api/"), "/mike/api");
  });
});

describe("stripBasePath", () => {
  test("no prefix configured means never rewrite", () => {
    assert.equal(stripBasePath("/api/auth/login", ""), null);
  });

  test("removes the prefix from a normal route", () => {
    assert.equal(stripBasePath("/api/auth/login", "/api"), "/auth/login");
  });

  test("the query string is preserved", () => {
    assert.equal(
      stripBasePath("/api/documents/overview?scope=all", "/api"),
      "/documents/overview?scope=all",
    );
  });

  test("the bare prefix maps to the root, with or without a query", () => {
    assert.equal(stripBasePath("/api", "/api"), "/");
    assert.equal(stripBasePath("/api?x=1", "/api"), "/?x=1");
  });

  test("a request without the prefix is left alone", () => {
    // The kubelet probes the pod directly and never goes through the ingress
    // that adds the prefix, so /health must keep working unprefixed.
    assert.equal(stripBasePath("/health", "/api"), null);
    assert.equal(stripBasePath("/health/ready", "/api"), null);
  });

  test("a route that merely starts with the same letters is not stripped", () => {
    // "/apidocs" is not "/api" + "/docs"; stripping it would route the request
    // somewhere it was never meant to go.
    assert.equal(stripBasePath("/apidocs", "/api"), null);
  });
});
