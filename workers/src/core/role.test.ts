import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import { registerRole, getRole, listRoles, type Role } from './role.js';

const fakeRole = (name: string): Role => ({ name, configSchema: z.object({}), buildAgent: () => ({}) as Agent });

describe('role registry', () => {
  it('registers and retrieves a role by name', () => {
    const role = fakeRole('role-a');
    registerRole(role);
    expect(getRole('role-a')).toBe(role);
    expect(listRoles()).toContain(role);
  });

  it('getRole returns undefined for an unknown name', () => {
    expect(getRole('does-not-exist')).toBeUndefined();
  });

  it('rejects duplicate registration', () => {
    registerRole(fakeRole('role-b'));
    expect(() => registerRole(fakeRole('role-b'))).toThrow(/already registered/);
  });
});
