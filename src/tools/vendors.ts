// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Vendor, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetVendor(
  env: Env,
  acumaticaUsername: string,
  args: { vendorId: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const vendor = await client.get<Vendor>(
    `Vendor/${encodeURIComponent(args.vendorId)}`,
    "acumatica_get_vendor",
    { vendorId: args.vendorId },
    { $expand: "MainContact,PrimaryContact" }
  );
  return unwrapFields(vendor);
}
