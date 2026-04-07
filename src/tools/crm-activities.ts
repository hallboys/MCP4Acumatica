// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EmailActivity, EventActivity, ActivityRecord, TaskRecord, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetEmail(
  env: Env,
  acumaticaUsername: string,
  args: { noteID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const email = await client.get<EmailActivity>(
    `Email/${encodeURIComponent(args.noteID)}`,
    "acumatica_get_email",
    { noteID: args.noteID }
  );
  return unwrapFields(email);
}

export async function handleGetEvent(
  env: Env,
  acumaticaUsername: string,
  args: { noteID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const event = await client.get<EventActivity>(
    `Event/${encodeURIComponent(args.noteID)}`,
    "acumatica_get_event",
    { noteID: args.noteID },
    { $expand: "Attendees" }
  );
  return unwrapFields(event);
}

export async function handleGetActivity(
  env: Env,
  acumaticaUsername: string,
  args: { noteID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const activity = await client.get<ActivityRecord>(
    `Activity/${encodeURIComponent(args.noteID)}`,
    "acumatica_get_activity",
    { noteID: args.noteID }
  );
  return unwrapFields(activity);
}

export async function handleGetTask(
  env: Env,
  acumaticaUsername: string,
  args: { noteID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const task = await client.get<TaskRecord>(
    `Task/${encodeURIComponent(args.noteID)}`,
    "acumatica_get_task",
    { noteID: args.noteID },
    { $expand: "RelatedActivities,RelatedTasks" }
  );
  return unwrapFields(task);
}
