// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards the endpoint-aware 404 re-messaging for the per-entity getters. On the
// stock "Default" endpoint a 404 keeps the client's plain message; on a custom
// Web Service Endpoint (ACUMATICA_ENDPOINT_NAME) it surfaces the "entity may not
// be exposed by this endpoint" cause.
//
// Run with:  node --test --experimental-strip-types test/getter-registry.test.ts

import { test } from "node:test";
import assert from "node:assert";
import { endpointAware404Message } from "../src/tools/getter-errors.ts";

test("Default endpoint: 404 keeps the plain message (returns null)", () => {
  assert.equal(endpointAware404Message(404, "Default", "Customer"), null);
});

test("non-404 statuses are never re-messaged, even on a custom endpoint", () => {
  for (const status of [200, 400, 401, 403, 500]) {
    assert.equal(endpointAware404Message(status, "CustomEndpoint", "Customer"), null, String(status));
  }
});

test("custom endpoint + 404: surfaces entity-not-exposed cause and discovery tools", () => {
  const msg = endpointAware404Message(404, "MyCustom", "SalesOrder");
  assert.ok(msg, "expected a non-null message");
  assert.match(msg!, /endpoint 'MyCustom'/);
  assert.match(msg!, /SalesOrder/);
  assert.match(msg!, /acumatica_list_entities/);
  assert.match(msg!, /acumatica_describe_entity/);
});
