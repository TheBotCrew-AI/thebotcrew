/**
 * Front-desk role registration.
 *
 * Import this module (side-effect) to register the role. New roles follow the
 * same shape (see CLAUDE.md "How to add a new role").
 */

import { registerRole, type Role } from '../../core/role.js';
import { buildFrontDeskAgent, FRONT_DESK_ROLE } from './agent.js';
import { frontDeskConfigSchema, type FrontDeskConfig } from './config.js';

export const frontDeskRole: Role<FrontDeskConfig> = {
  name: FRONT_DESK_ROLE,
  configSchema: frontDeskConfigSchema,
  buildAgent: buildFrontDeskAgent,
};

registerRole(frontDeskRole);

export { buildFrontDeskAgent, FRONT_DESK_ROLE, DEFAULT_MODEL } from './agent.js';
export type { FrontDeskConfig } from './config.js';
