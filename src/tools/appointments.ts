// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Appointment, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetAppointment(
  env: Env,
  acumaticaUsername: string,
  args: { serviceOrderType?: string; appointmentNbr: string }
): Promise<unknown> {
  const type = args.serviceOrderType || "SL";
  const client = new AcumaticaClient(env, acumaticaUsername);
  const appointment = await client.get<Appointment>(
    `Appointment/${encodeURIComponent(type)}/${encodeURIComponent(args.appointmentNbr)}`,
    "acumatica_get_appointment",
    { serviceOrderType: type, appointmentNbr: args.appointmentNbr },
    { $expand: "Details,Staff,Logs" }
  );
  return unwrapFields(appointment);
}
