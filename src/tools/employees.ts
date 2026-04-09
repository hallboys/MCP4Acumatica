// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Employee, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetEmployee(
  env: AppEnv,
  acumaticaUsername: string,
  args: { employeeID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const employee = await client.get<Employee>(
    `Employee/${encodeURIComponent(args.employeeID)}`,
    "acumatica_get_employee",
    { employeeID: args.employeeID },
    { $expand: "ContactInfo,EmployeeSettings,FinancialSettings" }
  );
  return unwrapFields(employee);
}
