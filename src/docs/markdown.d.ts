// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Allow importing .md files as text modules (wrangler Text rule)
declare module "*.md" {
  const content: string;
  export default content;
}
