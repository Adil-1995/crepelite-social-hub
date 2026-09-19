import { describe, expect, it } from 'vitest';
import { ROLES, can, canManageMember, type Role } from '@shared/index';

describe('permissions', () => {
  it('lets every role read the workspace', () => {
    for (const role of ROLES) expect(can(role, 'workspace.read')).toBe(true);
  });

  it('denies everything without a role', () => {
    expect(can(null, 'workspace.read')).toBe(false);
    expect(can(undefined, 'content.write')).toBe(false);
  });

  it('keeps viewers read-only', () => {
    expect(can('VIEWER', 'content.write')).toBe(false);
    expect(can('VIEWER', 'content.schedule')).toBe(false);
    expect(can('VIEWER', 'media.write')).toBe(false);
    expect(can('VIEWER', 'members.manage')).toBe(false);
    expect(can('VIEWER', 'connections.manage')).toBe(false);
    expect(can('VIEWER', 'logs.read')).toBe(true);
  });

  it('lets editors write content but not manage the workspace', () => {
    expect(can('EDITOR', 'content.write')).toBe(true);
    expect(can('EDITOR', 'content.schedule')).toBe(true);
    expect(can('EDITOR', 'media.write')).toBe(true);
    expect(can('EDITOR', 'members.manage')).toBe(false);
    expect(can('EDITOR', 'connections.manage')).toBe(false);
    expect(can('EDITOR', 'workspace.settings')).toBe(false);
  });

  it('reserves ownership operations for the owner', () => {
    expect(can('OWNER', 'workspace.transferOwnership')).toBe(true);
    expect(can('ADMIN', 'workspace.transferOwnership')).toBe(false);
    expect(can('OWNER', 'workspace.delete')).toBe(true);
    expect(can('ADMIN', 'workspace.delete')).toBe(false);
  });
});

describe('canManageMember', () => {
  it('never lets anyone touch an owner through the member flow', () => {
    for (const actor of ROLES) {
      expect(canManageMember(actor, 'OWNER', 'ADMIN')).toBe(false);
      expect(canManageMember(actor, 'ADMIN', 'OWNER')).toBe(false);
      expect(canManageMember(actor, 'OWNER', null)).toBe(false);
    }
  });

  it('lets the owner manage every non-owner role', () => {
    const targets: Array<Role | null> = ['ADMIN', 'EDITOR', 'VIEWER', null];
    for (const current of targets) {
      for (const next of targets) {
        expect(canManageMember('OWNER', current, next)).toBe(true);
      }
    }
  });

  it('lets an admin manage admins and below', () => {
    expect(canManageMember('ADMIN', 'EDITOR', 'VIEWER')).toBe(true);
    expect(canManageMember('ADMIN', 'ADMIN', 'EDITOR')).toBe(true);
    expect(canManageMember('ADMIN', 'VIEWER', 'ADMIN')).toBe(true);
  });

  it('stops editors and viewers managing anyone', () => {
    expect(canManageMember('EDITOR', 'VIEWER', 'EDITOR')).toBe(false);
    expect(canManageMember('VIEWER', 'VIEWER', 'VIEWER')).toBe(false);
  });
});
