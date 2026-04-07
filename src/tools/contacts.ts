// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ContactRecord, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetContact(
  env: Env,
  acumaticaUsername: string,
  args: { contactID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const contact = await client.get<ContactRecord>(
    `Contact/${encodeURIComponent(args.contactID)}`,
    "acumatica_get_contact",
    { contactID: args.contactID }
  );
  return unwrapFields(contact);
}
