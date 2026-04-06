// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Project, ProjectTask, ProjectBudget, ProjectTransaction, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetProject(
  env: Env,
  acumaticaUsername: string,
  args: { projectID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const project = await client.get<Project>(
    `Project/${encodeURIComponent(args.projectID)}`,
    "acumatica_get_project",
    { projectID: args.projectID }
  );
  return unwrapFields(project);
}

export async function handleGetProjectTask(
  env: Env,
  acumaticaUsername: string,
  args: { projectID: string; projectTaskID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const task = await client.get<ProjectTask>(
    `ProjectTask/${encodeURIComponent(args.projectID)}/${encodeURIComponent(args.projectTaskID)}`,
    "acumatica_get_project_task",
    { projectID: args.projectID, projectTaskID: args.projectTaskID }
  );
  return unwrapFields(task);
}

export async function handleGetProjectBudget(
  env: Env,
  acumaticaUsername: string,
  args: { projectID: string; projectTaskID: string; accountGroup: string; inventoryID?: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const pathParts = [
    encodeURIComponent(args.projectID),
    encodeURIComponent(args.projectTaskID),
    encodeURIComponent(args.accountGroup),
  ];
  if (args.inventoryID) {
    pathParts.push(encodeURIComponent(args.inventoryID));
  }
  const budget = await client.get<ProjectBudget>(
    `ProjectBudget/${pathParts.join("/")}`,
    "acumatica_get_project_budget",
    { projectID: args.projectID, projectTaskID: args.projectTaskID, accountGroup: args.accountGroup }
  );
  return unwrapFields(budget);
}

export async function handleGetProjectTransaction(
  env: Env,
  acumaticaUsername: string,
  args: { module: string; referenceNbr: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const txn = await client.get<ProjectTransaction>(
    `ProjectTransaction/${encodeURIComponent(args.module)}/${encodeURIComponent(args.referenceNbr)}`,
    "acumatica_get_project_transaction",
    { module: args.module, referenceNbr: args.referenceNbr },
    { $expand: "Details" }
  );
  return unwrapFields(txn);
}
