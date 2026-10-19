/**
 * Persistence port for permission classes and role bindings.
 *
 * Kept separate from `PermissionClassStore` for the same reason the config layer
 * splits service from repository: the resolution rules are business logic worth
 * testing without PostgreSQL, and Prisma stays an implementation detail of one
 * file.
 */
import type { PrismaDatabaseClient, RequiredJsonInput } from "../database/index.js";
import { toDatabaseError } from "../database/index.js";

/** A stored permission class row. */
export interface PermissionClassRow {
  readonly guildId: string;
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly string[];
  readonly builtIn: boolean;
  readonly priority: number;
}

/** A stored role → class binding. */
export interface RoleClassBinding {
  readonly guildId: string;
  readonly roleId: string;
  readonly classKey: string;
}

export interface PermissionClassRepository {
  listClasses(guildId: string): Promise<PermissionClassRow[]>;
  saveClass(row: PermissionClassRow): Promise<void>;
  removeClass(guildId: string, key: string): Promise<void>;
  listBindings(guildId: string): Promise<RoleClassBinding[]>;
  bindRole(guildId: string, roleId: string, classKey: string): Promise<void>;
  unbindRole(guildId: string, roleId: string, classKey: string): Promise<void>;
}

export class PrismaPermissionClassRepository implements PermissionClassRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async listClasses(guildId: string): Promise<PermissionClassRow[]> {
    try {
      const rows = await this.prisma.permissionClass.findMany({
        where: { guildId },
        orderBy: { priority: "desc" },
      });
      return rows.map((row) => ({
        guildId: row.guildId,
        key: row.key,
        name: row.name,
        permissions: toStringArray(row.permissions),
        builtIn: row.builtIn,
        priority: row.priority,
      }));
    } catch (error) {
      throw toDatabaseError(error, "permissionClass.list");
    }
  }

  public async saveClass(row: PermissionClassRow): Promise<void> {
    try {
      const permissions = [...row.permissions] as RequiredJsonInput;
      await this.prisma.permissionClass.upsert({
        where: { guildId_key: { guildId: row.guildId, key: row.key } },
        update: { name: row.name, permissions, builtIn: row.builtIn, priority: row.priority },
        create: {
          guildId: row.guildId,
          key: row.key,
          name: row.name,
          permissions,
          builtIn: row.builtIn,
          priority: row.priority,
        },
      });
    } catch (error) {
      throw toDatabaseError(error, "permissionClass.save");
    }
  }

  public async removeClass(guildId: string, key: string): Promise<void> {
    try {
      await this.prisma.permissionClass.deleteMany({ where: { guildId, key } });
    } catch (error) {
      throw toDatabaseError(error, "permissionClass.remove");
    }
  }

  public async listBindings(guildId: string): Promise<RoleClassBinding[]> {
    try {
      const rows = await this.prisma.rolePermissionClass.findMany({ where: { guildId } });
      return rows.map((row) => ({
        guildId: row.guildId,
        roleId: row.roleId,
        classKey: row.classKey,
      }));
    } catch (error) {
      throw toDatabaseError(error, "rolePermissionClass.list");
    }
  }

  public async bindRole(guildId: string, roleId: string, classKey: string): Promise<void> {
    try {
      await this.prisma.rolePermissionClass.upsert({
        where: { guildId_roleId_classKey: { guildId, roleId, classKey } },
        update: {},
        create: { guildId, roleId, classKey },
      });
    } catch (error) {
      throw toDatabaseError(error, "rolePermissionClass.bind");
    }
  }

  public async unbindRole(guildId: string, roleId: string, classKey: string): Promise<void> {
    try {
      await this.prisma.rolePermissionClass.deleteMany({ where: { guildId, roleId, classKey } });
    } catch (error) {
      throw toDatabaseError(error, "rolePermissionClass.unbind");
    }
  }
}

/** @returns the string members of a stored JSON array, ignoring anything else. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}
